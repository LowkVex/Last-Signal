/* ============================================================
   THE LAST SIGNAL — multiplayer client: remote survivors
   ------------------------------------------------------------
   Renders the OTHER players in your room inside the actual game
   world: procedural survivor rigs (same visual language as the
   game's hands/creature code — boxes & cylinders, muted colors),
   snapshot interpolation (~120ms render-behind for smoothness),
   walk cycles driven by real speed, crouch/hide/downed poses,
   headlamps with real lights, name tags, speaking indicators,
   positional footsteps, and — on the simulation host — footstep
   NOISE events so the creature hears every player, not just you.
   ============================================================ */
(function () {
  'use strict';

  const F = LS_NET.F;

  const R = MP.Remote = {
    players: new Map(),   // playerId -> entry
    bufferMs: 110,        // render behind live by this much
  };

  // survivor accent colors (muted, horror-appropriate)
  const ACCENTS = [0xc9a24b, 0x5f9e8f, 0xa85f4a, 0x7d8a5c, 0x6d7f9e, 0x9e7d8a];

  R.posOf = function (pid) {
    const e = R.players.get(pid);
    return e ? { x: e.draw.x, z: e.draw.z, y: e.draw.y } : null;
  };

  /* ---------------- rig construction ---------------- */

  function makeNameSprite(name, accent) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    const spr = { cv, ctx, name, accent, texture: null, sprite: null, dirty: true, speaking: false, status: '', bubble: '' };
    function redraw() {
      const c = spr.ctx;
      c.clearRect(0, 0, 256, 64);
      c.font = 'bold 22px "Courier New", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const label = (spr.bubble ? spr.bubble + ' ' : '') + (spr.status ? spr.status + ' ' : '') + spr.name;
      c.shadowColor = '#000'; c.shadowBlur = 6;
      c.fillStyle = spr.speaking ? '#bfe8c4' : (spr.status === 'DOWN' ? '#c66' : '#9fb09a');
      c.fillText(label.slice(0, 22), 128, 30);
      if (spr.speaking) {
        c.fillStyle = 'rgba(150,220,160,0.9)';
        for (let i = 0; i < 3; i++) c.fillRect(112 + i * 12, 48 + (i % 2) * 3, 6, 8 - (i % 2) * 3);
      }
      spr.texture.needsUpdate = true;
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    spr.texture = tex;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.92 });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(1.5, 0.375, 1);
    sp.position.y = 2.08;
    sp.renderOrder = 30;
    spr.sprite = sp;
    spr.redraw = redraw;
    redraw();
    return spr;
  }

  function buildRig(accent) {
    const g = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.92 });
    const suit2 = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.95 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a7460, roughness: 0.85 });
    const band = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6, emissive: accent, emissiveIntensity: 0.12 });

    // legs (pivot at hip)
    function leg(side) {
      const hip = new THREE.Group(); hip.position.set(0.11 * side, 0.88, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.46, 0.17), suit2);
      thigh.position.y = -0.23; hip.add(thigh);
      const knee = new THREE.Group(); knee.position.y = -0.46; hip.add(knee);
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.44, 0.14), suit2);
      shin.position.y = -0.22; knee.add(shin);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.09, 0.24), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 }));
      boot.position.set(0, -0.46, 0.045); knee.add(boot);
      return { hip, knee };
    }
    const legL = leg(-1), legR = leg(1);
    g.add(legL.hip, legR.hip);

    // torso
    const torso = new THREE.Group(); torso.position.y = 0.88; g.add(torso);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.24), suit);
    chest.position.y = 0.26; torso.add(chest);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.05, 0.245), band);
    stripe.position.y = 0.34; torso.add(stripe);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.12), suit2);
    pack.position.set(0, 0.28, 0.17); torso.add(pack);

    // arms (pivot at shoulder)
    function arm(side) {
      const sh = new THREE.Group(); sh.position.set(0.27 * side, 0.46, 0); torso.add(sh);
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.13), suit);
      up.position.y = -0.2; sh.add(up);
      const el = new THREE.Group(); el.position.y = -0.4; sh.add(el);
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.36, 0.11), suit);
      fore.position.y = -0.18; el.add(fore);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), skin);
      hand.position.y = -0.39; el.add(hand);
      return { sh, el };
    }
    const armL = arm(-1), armR = arm(1);

    // head + goggles
    const head = new THREE.Group(); head.position.y = 0.62; torso.add(head);
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.24, 0.22), skin);
    head.add(skull);
    const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.225, 0.07, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.3, emissive: 0x223344, emissiveIntensity: 0.25 }));
    goggles.position.set(0, 0.03, -0.1); head.add(goggles);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.1, 0.26), suit2);
    hood.position.y = 0.14; head.add(hood);

    // chest lamp (flashlight proxy): small emissive lens + real point light
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.06, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.4, metalness: 0.6, emissive: 0xfff0cf, emissiveIntensity: 0 }));
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(0.14, 0.4, -0.14); torso.add(lamp);
    const light = new THREE.PointLight(0xffe9c4, 0, 9, 2);
    light.position.set(0.14, 0.42, -0.2); light.castShadow = false;
    torso.add(light);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    return { root: g, legL, legR, armL, armR, torso, head, lamp, light };
  }

  /* ---------------- lifecycle ---------------- */

  R.spawn = function (pid, name, accentIdx) {
    if (R.players.has(pid) || pid === MP.playerId) return R.players.get(pid);
    const rig = buildRig(ACCENTS[(accentIdx === undefined ? R.players.size : accentIdx) % ACCENTS.length]);
    const tag = makeNameSprite(name || 'SURVIVOR', 0);
    rig.root.add(tag.sprite);
    if (MAIN.scene) MAIN.scene.add(rig.root);
    rig.root.visible = false;
    const e = {
      pid, name, rig, tag,
      buf: [],            // [{t, x,y,z, yaw, f, s}]
      draw: { x: 0, y: 0, z: 0, yaw: 0 },
      phase: Math.random() * 6, speed: 0, lastPos: null,
      crouch: false, hidden: false, downed: false, flash: false, moving: false,
      emote: null, emoteT: 0,
      stepAcc: 0, noiseAcc: 0,
    };
    R.players.set(pid, e);
    MP.emit('remote:spawn', { id: pid, name });
    return e;
  };

  R.despawn = function (pid) {
    const e = R.players.get(pid);
    if (!e) return;
    if (MAIN.scene) MAIN.scene.remove(e.rig.root);
    e.rig.root.traverse(o => {
      if (o.isMesh) { o.geometry && o.geometry.dispose && o.geometry.dispose(); }
    });
    if (e.tag) {
      if (e.tag.sprite && e.tag.sprite.material) e.tag.sprite.material.dispose();
      if (e.tag.texture) e.tag.texture.dispose();
    }
    R.players.delete(pid);
    MP.emit('remote:despawn', { id: pid, name: e.name });
  };

  R.clear = function () {
    for (const pid of [...R.players.keys()]) R.despawn(pid);
  };

  /* ---------------- snapshot intake ---------------- */

  R.onSnapshot = function (snap) {
    if (!snap || !Array.isArray(snap.p)) return;
    const t = snap.t || Date.now();
    for (const row of snap.p) {
      const [pid, x, y, z, yaw, f, s] = row;
      if (pid === MP.playerId) continue;
      let e = R.players.get(pid);
      if (!e) {
        const idx = MP.members.findIndex(m => m.id === pid);
        const name = (MP.members[idx] || {}).name || 'SURVIVOR';
        e = R.spawn(pid, name, idx < 0 ? undefined : idx);
      }
      e.buf.push({ t, x, y, z, yaw, f, s });
      if (e.buf.length > 40) e.buf.splice(0, e.buf.length - 40);
    }
  };

  /* ---------------- per-frame update ---------------- */

  R.update = function (dt) {
    const now = Date.now();
    const renderT = now - R.bufferMs;
    for (const [, e] of R.players) {
      // drop old
      while (e.buf.length > 2 && e.buf[1].t < renderT) e.buf.shift();

      let a = null, b = null, k = 0;
      if (e.buf.length >= 2 && e.buf[0].t <= renderT) {
        a = e.buf[0]; b = e.buf[e.buf.length - 1];
        for (let i = 0; i < e.buf.length - 1; i++) {
          if (e.buf[i].t <= renderT && e.buf[i + 1].t >= renderT) { a = e.buf[i]; b = e.buf[i + 1]; break; }
        }
        const span = Math.max(1, b.t - a.t);
        k = Math.max(0, Math.min(1, (renderT - a.t) / span));
      } else if (e.buf.length === 1) {
        a = b = e.buf[0]; k = 0;
      }
      if (!a) continue;

      const nx = a.x + (b.x - a.x) * k;
      const nz = a.z + (b.z - a.z) * k;
      const ny = (a.y || 0) + ((b.y || 0) - (a.y || 0)) * k;
      let yaw = a.yaw;
      if (a !== b) {
        let d = (b.yaw - a.yaw) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        yaw = a.yaw + d * k;
      }

      // velocity estimate for animation + footsteps
      const dx = nx - e.draw.x, dz = nz - e.draw.z;
      const instSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
      e.speed += (Math.min(instSpeed, 8) - e.speed) * Math.min(1, dt * 8);
      e.draw.x = nx; e.draw.y = ny; e.draw.z = nz; e.draw.yaw = yaw;

      const f = b.f | 0;
      e.crouch = !!(f & F.CROUCH);
      e.hidden = !!(f & F.HIDDEN);
      e.downed = !!(f & F.DOWNED);
      e.flash = !!(f & F.FLASH);
      const wasMoving = e.moving;
      e.moving = !!(f & F.MOVING);
      e.spotIdx = b.s === undefined ? -1 : b.s;

      // hide inside lockers: rig invisible while hidden
      const rig = e.rig;
      const visible = !e.hidden && MP.active;
      rig.root.visible = visible;
      if (visible) {
        rig.root.position.set(nx, 0, nz);
        rig.root.rotation.y = yaw;
        if (e.downed) {
          // collapsed on the floor
          rig.root.rotation.x = -Math.PI / 2 + Math.sin(now / 900) * 0.02;
          rig.root.position.y = 0.22;
          rig.light.intensity = 0;
          rig.lamp.material.emissiveIntensity = 0;
        } else {
          rig.root.rotation.x = 0;
          rig.root.position.y = 0;
          const crouchK = e.crouch ? 0.66 : 1;
          rig.root.scale.y += (crouchK - rig.root.scale.y) * Math.min(1, dt * 10);
          // walk cycle
          const spd = e.speed;
          e.phase += dt * (spd > 3.5 ? 11 : 7.5) * Math.min(1.4, Math.max(0.25, spd / 2.2));
          const sw = spd > 0.35 ? Math.min(0.85, 0.22 + spd * 0.13) : 0.04;
          const l1 = Math.sin(e.phase), l2 = Math.sin(e.phase + Math.PI);
          rig.legL.hip.rotation.x = l1 * sw;
          rig.legR.hip.rotation.x = l2 * sw;
          rig.legL.knee.rotation.x = Math.max(0, -l1) * sw * 0.9 + 0.05;
          rig.legR.knee.rotation.x = Math.max(0, -l2) * sw * 0.9 + 0.05;
          rig.armL.sh.rotation.x = l2 * sw * 0.75;
          rig.armR.sh.rotation.x = l1 * sw * 0.75;
          rig.armL.el.rotation.x = -0.15 - Math.max(0, -l2) * sw * 0.3;
          rig.armR.el.rotation.x = -0.15 - Math.max(0, -l1) * sw * 0.3;
          rig.torso.rotation.y = Math.sin(e.phase) * sw * 0.12;
          rig.torso.position.y = 0.88 + Math.abs(Math.sin(e.phase)) * (spd > 0.4 ? 0.03 : 0.006);
          rig.head.rotation.y = Math.sin(now / 1700 + e.phase * 0.1) * 0.12;
          // emote override (right arm / head) — plays over the walk cycle
          if (e.emoteT > 0) {
            e.emoteT -= dt;
            if (e.emote === 'wave') {
              rig.armR.sh.rotation.x = -2.35;
              rig.armR.sh.rotation.z = -0.3 + Math.sin(now / 95) * 0.35;
              rig.armR.el.rotation.x = -0.45;
            } else if (e.emote === 'point') {
              rig.armR.sh.rotation.x = -1.4;
              rig.armR.sh.rotation.z = 0;
              rig.armR.el.rotation.x = -0.05;
            } else if (e.emote === 'yes') {
              rig.head.rotation.x = Math.sin(now / 130) * 0.4;
            } else if (e.emote === 'no') {
              rig.head.rotation.y = Math.sin(now / 115) * 0.65;
            }
            if (e.emoteT <= 0) {
              e.emote = null;
              rig.armR.sh.rotation.z = 0;
              rig.head.rotation.x = 0;
              if (e.tag && e.tag.bubble) { e.tag.bubble = ''; e.tag.redraw(); }
            }
          }
          // headlamp
          const wantI = e.flash ? 1.15 : 0;
          rig.light.intensity += (wantI - rig.light.intensity) * Math.min(1, dt * 6);
          rig.lamp.material.emissiveIntensity = e.flash ? 1.6 + Math.sin(now / 90) * 0.15 : 0;
        }
      } else {
        rig.light.intensity = 0;
      }

      // name tag status
      const st = e.downed ? 'DOWN' : e.hidden ? '' : '';
      const pc = V_peerEntry(e.pid);
      const speaking = !!pc;
      if (e.tag.status !== st || e.tag.speaking !== speaking) {
        e.tag.status = st; e.tag.speaking = speaking; e.tag.redraw();
      }

      // positional footsteps (audible to everyone, scaled by distance to local player)
      if (e.moving && !e.hidden && !e.downed && e.speed > 0.5) {
        const stride = (f & F.SPRINT) ? 2.3 : e.crouch ? 1.3 : 1.85;
        e.stepAcc += e.speed * dt;
        if (e.stepAcc > stride) {
          e.stepAcc = 0;
          _footstep(e, f);
        }
      } else e.stepAcc = 0;

      // SIM HOST ONLY: remote movement makes NOISE the creature can hear
      if (MP.isSimHost && MP.active && e.moving && !e.hidden && !e.downed) {
        e.noiseAcc += e.speed * dt;
        const stride = (f & F.SPRINT) ? 2.35 : e.crouch ? 1.6 : 1.85;
        if (e.noiseAcc > stride) {
          e.noiseAcc = 0;
          const sprinting = !!(f & F.SPRINT);
          const radius = sprinting ? 12.5 : e.crouch ? 1.6 : 4.5;
          G.noise({ x: nx, z: nz }, radius, sprinting ? 'sprint' : 'step');
          if (sprinting) MON.adapt.sprints++;
        }
      }
      void wasMoving;
    }
  };

  function V_peerEntry(pid) {
    const e = MP.Voice && MP.Voice.pcs ? MP.Voice.pcs.get(pid) : null;
    return e && e.speaking ? e : null;
  }

  function _footstep(e, f) {
    if (!window.AUD || !AUD.ready || !G.player) return;
    const pl = G.player;
    const d = Math.hypot(e.draw.x - pl.pos.x, e.draw.z - pl.pos.z);
    if (d > 22) return;
    const reg = WORLD.regionAt ? WORLD.regionAt(e.draw.x, e.draw.z) : null;
    const surface = reg ? (reg.floor === 'metal' ? 'metal' : reg.floor === 'tile' ? 'tile' : 'concrete') : 'concrete';
    const base = (f & F.SPRINT) ? 0.6 : (f & F.CROUCH) ? 0.1 : 0.34;
    const vol = base * Math.max(0.08, 1 - d / 20);
    AUD.play('step', { surface, vol });
  }

  R.setSpeaking = function (pid, speaking) {
    const e = R.players.get(pid);
    if (e && e.tag.speaking !== speaking) { e.tag.speaking = speaking; e.tag.redraw(); }
  };

  const EMOTE_S = { wave: 2.2, point: 2.0, yes: 1.6, no: 1.6 };
  const EMOTE_TAG = { wave: '👋', point: '👉', yes: '✔', no: '✖' };

  /** server-relayed emote: bubble over the name tag + body animation */
  R.playEmote = function (pid, emote) {
    const e = R.players.get(pid);
    if (!e || !EMOTE_S[emote]) return;
    e.emote = emote;
    e.emoteT = EMOTE_S[emote];
    const b = EMOTE_TAG[emote] || '';
    if (e.tag && e.tag.bubble !== b) { e.tag.bubble = b; e.tag.redraw(); }
  };

  R.updateNames = function () {
    for (const [, e] of R.players) {
      const m = MP.members.find(x => x.id === e.pid);
      if (m && m.name !== e.name) { e.name = m.name; e.tag.name = m.name; e.tag.redraw(); }
    }
  };
})();
