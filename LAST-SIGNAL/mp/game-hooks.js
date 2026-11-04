/* ============================================================
   THE LAST SIGNAL — multiplayer client: game integration hooks
   ------------------------------------------------------------
   Binds the EXISTING single-player systems (world, chapters,
   doors, puzzles, creature AI, hiding, skill checks, endings)
   to the authoritative server WITHOUT replacing them:

   - every shared gameplay outcome becomes an *intent* sent to
     the server (game:event); the server validates it against
     the objective graph + world anchors + positions and only
     then broadcasts game:applied — every client (including the
     sender) applies the ORIGINAL game functions under the
     MP.applying gate. The client never decides outcomes.
   - simulation host: runs the real creature AI (MON.update)
     against a PROXY of whichever player the creature should be
     focused on (nearest visible / loudest), then streams
     validated monster snapshots through the server.
   - everyone else: the creature is driven by server snapshots
     with full original animation + positional audio.
   - downs validated server-side (monster must be on the victim),
     revives by holding E, team wipe -> shared checkpoint rewind.
   Single-player is untouched: every hook checks MP.active.
   ============================================================ */
(function () {
  'use strict';

  const EV = LS_NET.EV, GE = LS_NET.GE, F = LS_NET.F;

  const GM = MP.Game = {
    anchors: null,
    lastMonster: null,
    monsterRecvT: 0,
    sendAcc: 0,
    iAmDowned: false,
    pendingDeath: null,
    reviveHold: null,       // {target, t}
    wipeShown: false,
    endingShown: false,
    skillPending: false,
    _proxy: null,
    _proxyTarget: null,
    matchStartT: 0,
  };

  /* ============================================================
     frame hooks — one wrapped point so nothing in the original
     loop is reordered
     ============================================================ */

  GM.install = function () {
    if (GM._installed) return;
    GM._installed = true;

    // wrap the frame body: pre/post around the ORIGINAL loop
    const origFrame = MAIN._frameBody;
    MAIN._frameBody = function () {
      try { GM.preFrame(); } catch (e) { console.error('[MP] preFrame', e); }
      origFrame.call(MAIN);
      try { GM.postFrame(); } catch (e) { console.error('[MP] postFrame', e); }
    };

    // wrap MON.update: proxy swap on sim host / snapshot drive elsewhere
    const origMonUpdate = MON.update;
    GM._origMonUpdate = origMonUpdate;
    MON.update = function (dt) {
      if (!MP.active) return origMonUpdate.call(MON, dt);
      if (!MP.isSimHost) { GM.driveMonsterFromNet(dt); return; }
      // --- simulation host: focus the creature on the best target via proxy ---
      const real = G.player;
      const proxy = GM.pickProxyTarget();
      if (proxy && proxy !== real) {
        G.player = proxy;
        try { origMonUpdate.call(MON, dt); }
        finally { G.player = real; }
      } else {
        try { origMonUpdate.call(MON, dt); }
        finally { G.player = real; }
      }
      GM.sendMonster(dt);
    };

    // wrap STORY.save — multiplayer never touches the local SP save slot
    const origSave = STORY.save;
    STORY.save = function () { if (MP.active) return; return origSave.call(STORY); };

    // wrap UI.showMenu — when in a room, the room panel is "home", not the main menu
    const origShowMenu = UI.showMenu;
    UI.showMenu = function () {
      if (MP.inRoom && MP.UI) { origShowMenu.call(UI); $('menu').classList.add('hidden'); MP.UI.showRoomPanelFromMenu(); return; }
      return origShowMenu.call(UI);
    };

    // wrap saveSettings -> also persist to the cloud profile (debounced)
    const origSaveSettings = window.saveSettings;
    if (typeof origSaveSettings === 'function') {
      window.saveSettings = function () { origSaveSettings(); if (MP.Auth.user) MP.Auth.saveSettingsCloud(); };
    }

    // director: on non-sim clients the creature is server-driven — never let
    // local horror events reposition it (all other events stay personal & local)
    const origPick = DIRECTOR.pickEvent;
    DIRECTOR.pickEvent = function (stress) {
      const ev = origPick.call(this, stress);
      if (MP.active && !MP.isSimHost && (ev === 'glimpse' || ev === 'manifest')) return 'distantSteps';
      return ev;
    };

    // sound events must not pile up when the local client does not run the AI
    GM._drainT = 0;
  };

  /* ============================================================
     pre/post frame
     ============================================================ */

  GM.preFrame = function () {
    const now = performance.now();
    const dt = Math.min(0.06, (now - (GM._lastT || now)) / 1000);
    GM._lastT = now;
    // voice proximity runs in the room lobby too (everybody hears everybody there)
    if (MP.Voice && MP.Voice.enabled && (MP.active || MP.inRoom)) MP.Voice.updateProximity(dt);
    if (!MP.active) return;
    MP.Remote.update(dt);
    MP.Net.tickMovement(dt);
    GM.updateReviveHold(dt);
    // drain stale sound events on non-sim clients (the AI is not consuming them here)
    if (!MP.isSimHost) {
      GM._drainT += dt;
      if (GM._drainT > 1) { GM._drainT = 0; MON.soundEvents.length = 0; }
    }
  };

  let _lastFrameT = performance.now();
  GM.postFrame = function () {
    _lastFrameT = performance.now();
    void _lastFrameT;
    if (!MP.active) return;
    GM.updatePrompts();
    // revive-hold prompt must be written AFTER INTERACT.update cleared it this frame
    if (GM.reviveHold) {
      const target = MP.members.find(m => m.id === GM.reviveHold.target);
      UI.setPrompt('REVIVING ' + ((target && target.name) || 'SURVIVOR'), `${Math.min(100, Math.round(GM.reviveHold.t / 3 * 100))}% — KEEP HOLDING [E]`);
    }
  };

  /* ============================================================
     match lifecycle
     ============================================================ */

  GM.devGuestId = function () {
    let id = null;
    try { id = localStorage.getItem('tls_dev_guest'); } catch (e) {}
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
      try { localStorage.setItem('tls_dev_guest', id); } catch (e) {}
    }
    return id;
  };

  /** server: GAME_START — the host pressed START and everyone is ready */
  GM.onMatchStart = function (d) {
    MP.active = true;
    MP.applying = true;
    GM.wipeShown = false; GM.endingShown = false; GM.iAmDowned = false;
    GM.matchStartT = Date.now();
    try {
      const campaign = d.campaign || 1;
      MP.campaign = campaign;
      MP.isSimHost = (d.simHostId === MP.playerId);
      const me = (d.members || []).find(m => m.id === MP.playerId);
      MP.slot = me ? me.slot : (d.slots && d.slots[MP.playerId] !== undefined ? d.slots[MP.playerId] : 0);
      GM.beginWorld(campaign, null);
      GM.spawnAtCheckpoint(null, MP.slot);
      if (MP.UI) MP.UI.enterMatchUI();
      // sim host registers the canonical world anchors for server-side validation
      if (MP.isSimHost) setTimeout(() => GM.sendAnchors(), 300);
    } finally {
      MP.applying = false;
    }
  };

  /** server: GAME_SNAPSHOT — join-in-progress or reconnect resync */
  GM.onMatchSnapshot = function (snap, opts = {}) {
    if (!snap || !snap.state) return;
    const st = snap.state;
    if (st.phase !== 'playing') {
      // match already ended while we were away
      if (MP.UI) MP.UI.sysToast('That expedition has already ended.');
      return;
    }
    MP.active = true;
    MP.applying = true;
    GM.wipeShown = false; GM.endingShown = false;
    try {
      MP.campaign = st.campaign;
      MP.slot = snap.slot !== undefined && snap.slot >= 0 ? snap.slot : 0;
      MP.isSimHost = (snap.simHostId === MP.playerId);
      GM.beginWorld(st.campaign, st);
      // shared state
      G.state.chapter = st.chapter || G.state.chapter;
      G.state.flags = Object.assign({}, st.flags);
      STORY.started = true;
      STORY._beats = {};
      if (st.chapter >= 2) STORY._beats.ch2 = true;
      STORY.medScareDone = !!st.flags.medScare;
      STORY.firstSkillCheck = true;
      STORY.generic = st.campaign > 1 ? GEN.last : null;
      STORY._gStep = -1;
      STORY._completing = false;
      // doors
      if (st.doors) for (const key of Object.keys(st.doors)) {
        const ds = st.doors[key];
        const door = WORLD.doors.find(dd => dd.key === key);
        if (!door) continue;
        if (ds.unlocked) {
          door.unlocked = true;
          WORLD.navLockKeys.delete(door.key);
          if (door.readerMesh) door.readerMesh.material.emissive.setHex(0x227733);
        }
        if (ds.open && door.unlocked) WORLD.openDoor(door, true);
      }
      // power derived from flags
      if (st.flags.powerOn) WORLD.setPower('main', true);
      if (st.flags.liftReady) WORLD.setPower('lift', true);
      // fuse panel visuals
      if (G.fusePanel && st.fusesInstalled) {
        for (let i = 0; i < Math.min(2, st.fusesInstalled); i++) GM.applyFuseVisual(i);
      }
      // my inventory of progression items
      const mine = (st.playerItems || {})[MP.playerId];
      if (mine) {
        if (mine.keycard) { G.inv.items.push({ id: 'keycard', count: 1 }); }
        const fuses = (mine.fusesHeld || 0) - (mine.fusesUsed || 0);
        if (fuses > 0) G.inv.items.push({ id: 'fuse', count: fuses });
        G.inv.render();
      }
      // consumed pickups
      if (st.pickupsTaken) for (const pid of Object.keys(st.pickupsTaken)) {
        const it = WORLD.interactables.find(i => i.id === pid);
        if (it) { it.dead = true; if (it.mesh && it.mesh.parent) it.mesh.parent.remove(it.mesh); }
      }
      // warm-up timer
      if (st.warmupEndsAt && st.warmupEndsAt > Date.now()) {
        STORY.warmup = (st.warmupEndsAt - Date.now()) / 1000;
        STORY._lastWarmInt = Math.ceil(STORY.warmup) + 1;
      } else STORY.warmup = -1;
      // checkpoint / spawn
      const cp = st.checkpoint;
      if (cp) G.state.checkpoint = { chapter: G.state.chapter, campaign: st.campaign, gx: cp.gx, gy: cp.gy, yaw: cp.yaw || 0 };
      GM.spawnAtCheckpoint(cp, MP.slot);
      // monster: seed from last snapshot; sim host adopts it
      if (st.monster) {
        GM.lastMonster = st.monster;
        GM.monsterRecvT = performance.now();
        if (MP.isSimHost) GM.adoptMonsterAsSimHost(st.monster);
      }
      // downed states
      GM.iAmDowned = (snap.downed || []).includes(MP.playerId);
      // objective text
      if (STORY.restoreObjective) STORY.restoreObjective();
      if (MP.UI) MP.UI.enterMatchUI();
      if (MP.isSimHost) setTimeout(() => GM.sendAnchors(), 300);
      UI.toast(opts.joined !== false ? 'Signal reacquired. Rejoining the expedition.' : 'You dropped back into the facility.', 4200);
    } catch (e) {
      console.error('[MP] snapshot apply failed', e);
    } finally {
      MP.applying = false;
    }
  };

  /** (re)build the world for a campaign and reset match-local systems */
  GM.beginWorld = function (campaign, st) {
    UI.closeAllPanelsSilent();
    $('deathScreen').classList.remove('on');
    $('endingScreen').classList.add('hidden');
    MAIN.newGame(campaign);            // original world builder — untouched
    // MAIN.newGame ends with STORY.beginNewGame(campaign); flags were just reset —
    // re-apply any server state handled by the caller afterwards.
    MP.Remote.clear();
    GM.lastMonster = null;
    MON.soundEvents.length = 0;
    GM._proxyTarget = null;
    void st;
  };

  GM.spawnAtCheckpoint = function (cp, slot) {
    cp = cp || G.state.checkpoint || MAP.checkpoints[1];
    const baseX = cw(cp.gx - 0.5) + CELL / 2;
    const baseZ = cw(cp.gy - 0.5) + CELL / 2;
    const ang = (slot || 0) * (Math.PI * 2 / 6) + 0.6;
    let x = baseX + Math.cos(ang) * 1.15, z = baseZ + Math.sin(ang) * 1.15;
    const o = WORLD.nearestOpen ? WORLD.nearestOpen(x, z, 3) : null;
    if (o) { x = o.x; z = o.z; }
    G.player.respawn(x, z, cp.yaw || 0);
    G.state.scene = 'play';
    MAIN.requestLock();
  };

  /** sim host: canonical world points the server validates interactions against */
  GM.sendAnchors = function () {
    try {
      const doors = WORLD.doors.map(d => ({ key: d.key, type: d.def.type, code: d.def.code || null, x: +d.px.toFixed(2), z: +d.pz.toFixed(2) }));
      const pickups = WORLD.interactables.filter(i => i.type === 'pickup').map(i => ({ id: i.id, item: i.itemId, x: +i.pos.x.toFixed(2), z: +i.pos.z.toFixed(2) }));
      const regions = (MAP.regions || []).map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, zone: r.zone }));
      const hideSpots = WORLD.hideSpots.map(s => ({ x: +s.pos.x.toFixed(2), z: +s.pos.z.toFixed(2) }));
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const r of (MAP.regions || [])) {
        minX = Math.min(minX, r.x * CELL); maxX = Math.max(maxX, (r.x + r.w) * CELL);
        minZ = Math.min(minZ, r.y * CELL); maxZ = Math.max(maxZ, (r.y + r.h) * CELL);
      }
      const pos = (o) => o ? { x: +o.x.toFixed(2), z: +o.z.toFixed(2) } : null;
      const term = PROPS.terminals && PROPS.terminals.freq ? pos(PROPS.terminals.freq.pos || PROPS.terminals.freq) : (G.freqTerminal ? pos(G.freqTerminal.pos) : null);
      const elevDoor = WORLD.doors.find(d => d.def.type === 'elevator');
      const ride = WORLD.interactables.find(i => i.id === 'elevator_ride');
      const exitRoom = (MP.campaign > 1 && GEN.last && GEN.last.exitRoom)
        ? { gx: GEN.last.exitRoom.x, gy: GEN.last.exitRoom.y, w: GEN.last.exitRoom.w, h: GEN.last.exitRoom.h, x: GEN.last.exitRoom.x, z: GEN.last.exitRoom.y }
        : null;
      const anchors = {
        campaign: MP.campaign, doors, pickups, regions, hideSpots,
        fusePanel: G.fusePanel ? pos(G.fusePanel.pos) : null,
        lever: G.elevatorLever ? pos(G.elevatorLever.pos) : null,
        console: G.containmentConsole ? pos(G.containmentConsole.pos) : null,
        freq: term,
        core: G.signalCore ? pos(G.signalCore.pos) : null,
        elevator: elevDoor ? pos({ x: elevDoor.px, z: elevDoor.pz }) : null,
        elevatorRide: ride ? pos(ride.pos) : null,
        exitRoom,
        bounds: { minX, maxX, minZ, maxZ },
        spawn: pos({ x: cw(MAP.checkpoints[1].gx - 0.5) + CELL / 2, z: cw(MAP.checkpoints[1].gy - 0.5) + CELL / 2 }),
      };
      GM.anchors = anchors;
      MP.Net.sendAnchors(anchors, (res) => {
        if (!res || !res.ok) console.warn('[MP] anchors rejected:', res && res.error);
      });
    } catch (e) { console.error('[MP] anchor collection failed', e); }
  };

  /* ============================================================
     intents -> server  (the client ASKS, the server DECIDES)
     ============================================================ */

  GM.requestEvent = function (type, payload, opts = {}) {
    const ev = Object.assign({ type }, payload || {});
    if (!opts.noAt && G.player) ev.at = [+G.player.pos.x.toFixed(2), +G.player.pos.z.toFixed(2)];
    MP.Net.sendGameEvent(ev, (res) => {
      if (!res || !res.ok) {
        if (opts.onRejected) opts.onRejected(res);
        else if (res && res.error && !opts.quiet) console.info('[MP] event rejected:', type, res.error);
      }
    });
  };

  /** local convenience: am I allowed to act? (dead / downed / not in match) */
  GM.canAct = function () { return MP.active && !GM.iAmDowned && G.player && !G.player.dead; };

  /* one-shot intent helpers (region triggers fire every frame until applied) */
  GM._sentOnce = new Set();
  GM.requestOnce = function (type, onRejected, payload) {
    const key = type + ':' + JSON.stringify(payload || {});
    if (GM._sentOnce.has(key)) return;
    GM._sentOnce.add(key);
    GM.requestEvent(type, payload, {
      quiet: true,
      onRejected: (res) => { GM._sentOnce.delete(key); if (onRejected) onRejected(res); },
    });
  };
  GM.requestChapter = function (n, onRejected) {
    GM.requestOnce('chapter', onRejected, { n });
  };

  /* ============================================================
     server-authoritative event application
     ============================================================ */

  GM.onApplied = function (d) {
    if (!d || !d.type) return;
    const by = d.by;
    const byName = (MP.members.find(m => m.id === by) || {}).name || 'A survivor';
    MP.applying = true;
    try {
      switch (d.type) {

        case GE.FLAG: {
          G.state.flags[d.name] = true;
          break;
        }

        case GE.CHAPTER: {
          if (d.n === 2) STORY.enterChapter2();
          else if (d.n === 3) STORY.enterChapter3();
          else if (d.n === 4) STORY.enterChapter4();
          G.state.chapter = d.n;
          break;
        }

        case GE.MEDSCARE: {
          STORY.medScareDone = false;   // allow the beat to run everywhere
          STORY.medScare();
          break;
        }

        case GE.DOOR: {
          const door = WORLD.doors.find(dd => dd.key === d.key);
          if (door) {
            if (d.open) WORLD.openDoor(door, by === MP.playerId ? false : 0.15);
            else WORLD.closeDoor(door, by === MP.playerId ? false : 0.15);
          }
          break;
        }

        case GE.UNLOCK: {
          const door = WORLD.doors.find(dd => dd.key === d.key);
          if (door) {
            door.unlocked = true;
            WORLD.navLockKeys.delete(door.key);
            if (door.readerMesh) door.readerMesh.material.emissive.setHex(0x227733);
            if (d.method === 'keycard') {
              AUD.play('keypad', {});
              UI.toast(by === MP.playerId ? 'KEYCARD ACCEPTED' : `${byName} unlocked a door somewhere. The facility noticed.`, 4200);
              WORLD.openDoor(door, false);
              STORY.onDoorUnlocked('keycard_door');
            } else if (d.method === 'code') {
              AUD.play('keypad', {});
              UI.toast(by === MP.playerId ? 'CODE ACCEPTED. Heavy bolts retract.' : `${byName} cracked a keypad. Bolts retract somewhere deep.`, 4200);
              WORLD.openDoor(door, false);
              STORY.onDoorUnlocked('code_door');
              UI.closeAllPanels();
            }
          }
          break;
        }

        case GE.UNLOCK_FAILED: {
          // wrong code: everyone hears the buzzer; the sim host feeds the noise to the creature
          if (by === MP.playerId) {
            AUD.play('errorBuzz');
            const disp = $('keyDisplay'); if (disp) { disp.classList.add('err'); setTimeout(() => disp.classList.remove('err'), 400); }
            UI._keyInput = '';
            UI.toast('ACCESS DENIED. The buzzer echoes down the tunnel.', 3200);
          } else {
            const door = WORLD.doors.find(dd => dd.key === d.key);
            if (door && G.player) {
              const dist = Math.hypot(door.px - G.player.pos.x, door.pz - G.player.pos.z);
              if (dist < 26) AUD.play('errorBuzz', { pos: { x: door.px, y: 1.2, z: door.pz }, vol: Math.max(0.1, 0.5 - dist / 60) });
            }
            if (MP.isSimHost) {
              const door2 = WORLD.doors.find(dd => dd.key === d.key);
              if (door2) G.noise({ x: door2.px, z: door2.pz }, 10, 'alarm');
            }
          }
          break;
        }

        case GE.PICKUP: {
          const it = WORLD.interactables.find(i => i.id === d.id);
          if (it) {
            if (by === MP.playerId) {
              // I picked it up: real inventory add (original action path)
              G.inv.add(d.item || it.itemId, it.count || 1);
              AUD.play('pickup');
              STORY.onPickup(it.itemId);
            } else if (d.item === 'keycard') {
              UI.toast(`${byName} took the maintenance keycard.`, 3800);
            }
            if (it.mesh && it.mesh.parent) it.mesh.parent.remove(it.mesh);
            it.dead = true;
          }
          break;
        }

        case GE.FUSE: {
          GM.applyFuseVisual(d.slot);
          if (by === MP.playerId) { G.inv.remove('fuse', 1); AUD.play('pickup'); }
          G.noise && MP.isSimHost && G.fusePanel && G.noise(G.fusePanel.pos, 8, 'panel');
          break;
        }

        case GE.POWER: {
          WORLD.setPower(d.bus, d.on);
          if (d.bus === 'main' && d.on) {
            UI.flashWhite(0.15);
            AUD.play('powerUp', { pos: G.fusePanel ? G.fusePanel.pos : undefined, vol: 0.7 });
            UI.toast('The panel THUNKS. Deep in the facility, magnetic locks release.', 6500);
            if (MP.isSimHost && G.fusePanel) G.noise(G.fusePanel.pos, 22, 'power');
          }
          break;
        }

        case GE.CHECKPOINT: {
          G.state.checkpoint = { chapter: G.state.chapter, campaign: MP.campaign, gx: d.gx, gy: d.gy, yaw: d.yaw || 0 };
          if (by !== MP.playerId && !GM._cpToastT) { GM._cpToastT = setTimeout(() => { GM._cpToastT = null; }, 4000); UI.toast('— CHECKPOINT —', 2200); }
          break;
        }

        case GE.LEVER: {
          STORY.pullLever();     // original: chapter 5 card, toast, warm-up, aggro (sim host), alarms
          break;
        }

        case GE.LIFT_READY: {
          if (MP.campaign === 1) STORY.elevatorReady();
          else STORY.genericLeverReady();
          break;
        }

        case GE.CALIBRATED: {
          if (by === MP.playerId) {
            UI._freqLockT = 0;
            UI.closeAllPanels();
          }
          G.state.flags.calibrated = true;
          STORY.onCalibrated();
          break;
        }

        case GE.CONTAINMENT: {
          GM.applyContainment(by);
          break;
        }

        case GE.CORE_TOUCHED: {
          G.state.flags.signalTouched = true;
          if (by === MP.playerId) {
            STORY.touchCore();          // full original sequence for the toucher (modal, fx)
          } else {
            AUD.play('deepBoom', { vol: 0.5 });
            UI.toast('Somewhere below, the hum folds in on itself. Someone touched the core.', 6000);
          }
          break;
        }

        case GE.TRUTH_READ: {
          G.state.flags[d.name] = true;
          break;
        }

        case GE.ENDING: {
          GM.applyEnding(d.id, by);
          break;
        }

        case GE.CHAPTER_COMPLETE: {
          GM.applyChapterComplete(d.n);
          break;
        }

        case GE.REWIND: {
          GM.applyRewind(d);
          break;
        }

        case 'team_wipe': {
          GM.onTeamWipe();
          break;
        }

        case 'player_left': {
          MP.Remote.despawn(d.player);
          if (d.player !== MP.playerId) UI.toast(`${byName === 'A survivor' ? 'A survivor' : byName}'s signal vanished from the net.`, 4000);
          break;
        }

        default: break;
      }
    } catch (e) {
      console.error('[MP] apply failed:', d.type, e);
    } finally {
      MP.applying = false;
    }
  };

  GM.applyFuseVisual = function (slotIdx) {
    const fp = G.fusePanel;
    if (!fp || !fp.slots) return;
    const slot = fp.slots[slotIdx];
    if (!slot || slot.filled) return;
    slot.filled = true;
    const fuseMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0xc8b8a0, transparent: true, opacity: 0.85, roughness: 0.3 }));
    fuseMesh.rotation.x = Math.PI / 2;
    fuseMesh.position.z = 0.04;
    slot.slot.add(fuseMesh);
    slot.led.material.emissive.setHex(0x33ff55);
    AUD.play('spark', { pos: fp.pos, vol: 0.4 });
  };

  GM.applyContainment = function (by) {
    G.state.flags.containment = true;
    const cc = G.containmentConsole;
    AUD.play('powerUp', { pos: cc ? cc.pos : undefined, vol: 0.8 });
    AUD.play('deepBoom', { vol: 1.0 });
    setTimeout(() => AUD.play('monScreech', { pos: MON.pos3(), vol: 1.0, dur: 2.2 }), 1200);
    UI.flashWhite(0.5);
    if (G.player) G.player.shake(0.8);
    if (cc && cc.screen) {
      const newTex = TEX.screen(['CONTAINMENT', 'STATUS: RE-SEALED', '', 'RESONANCE: FADING', 'OBSERVER: ...LOCKED?'], '#66ccff');
      cc.screen.material.map = newTex; cc.screen.material.emissiveMap = newTex; cc.screen.material.needsUpdate = true;
    }
    if (MP.isSimHost) MON.forceRetreat(true, false);
    UI.toast(by === MP.playerId
      ? 'The tank floods with light. The screaming folds in on itself, smaller and smaller.'
      : 'The tank floods with light somewhere far below. Everything in the facility stops moving at once.', 8000);
    UI.setObjective('It is sealed — with part of someone on the inside. Reach the FREIGHT ELEVATOR in the signal chamber.');
    G.state.stress = 0.2;
    setTimeout(() => AUD.setSilence(true), 2000);
    setTimeout(() => AUD.setSilence(false), 12000);
  };

  GM.applyEnding = function (id, by) {
    if (GM.endingShown) return;
    GM.endingShown = true;
    void by;
    const e = ENDINGS[id] || ENDINGS.A;
    G.state.flags.ending = id;
    MAIN.beginEndingSequence();
    AUD.setSilence(true);
    setTimeout(() => AUD.play('deepBoom', { vol: 0.7 }), 3000);
    // shared ending — everyone escapes together or not at all
    UI.endingScreen(e.title, e.text, () => {
      GM.returnToRoom();
    });
    // milestone persistence: local (RLS-protected own row) + server-side (secret key) both merge
    if (MP.Auth.user) {
      MP.Auth.saveMilestone({
        unlocked: 2, completed: { '1': true }, endings: { [id]: true },
        stats: { games: 1, escapes: 1, chapters: 1, playtime_s: Math.max(0, Math.round((Date.now() - GM.matchStartT) / 1000)) },
        campaign: MP.campaign,
      });
    }
  };

  GM.applyChapterComplete = function (n) {
    if (GM.endingShown) return;
    GM.endingShown = true;
    const spec = GEN.CHAPTERS[n];
    AUD.music.stop();
    AUD.play('powerUp', { vol: 0.8 });
    AUD.play('deepBoom', { vol: 0.6 });
    AUD.setSilence(false);
    // local chapter-select progress + cloud
    const prog = UI.getProgress();
    if (prog.completed.indexOf(n) === -1) prog.completed.push(n);
    prog.unlocked = Math.max(prog.unlocked, Math.min(8, n + 1));
    STORE.set('progress', prog);
    if (MP.Auth.user) {
      MP.Auth.saveMilestone({
        unlocked: Math.min(8, n + 1), completed: { [String(n)]: true }, endings: null,
        stats: { games: 1, escapes: 1, chapters: 1, playtime_s: Math.max(0, Math.round((Date.now() - GM.matchStartT) / 1000)) },
        campaign: n,
      });
    }
    STORY._completing = true;
    UI.endingScreen(
      'CHAPTER ' + n + ' COMPLETE',
      spec.title + '\n\n' + (STORY.COMPLETE_TEXT[n] || 'You made it out.') +
      (n < 8 ? '\n\n— CHAPTER ' + (n + 1) + ' UNLOCKED —' : '\n\n— THE CAMPAIGN IS COMPLETE —'),
      () => { STORY._completing = false; GM.returnToRoom(); }
    );
  };

  GM.returnToRoom = function () {
    GM.leaveMatch(false);
    $('endingScreen').classList.add('hidden');
    $('endingTitle').style.opacity = 0;
    G.state.scene = 'menu';
    MAIN.toMenu();
    if (MP.UI) MP.UI.showRoomPanelFromMenu();
  };

  /** tear down match-local state; keep the socket & room membership unless leaving */
  GM.leaveMatch = function (leavingRoom) {
    MP.active = false;
    MP.isSimHost = false;
    GM.iAmDowned = false;
    GM.pendingDeath = null;
    GM.wipeShown = false;
    GM.endingShown = false;
    GM.lastMonster = null;
    GM._proxyTarget = null;
    GM._sentOnce.clear();
    MP.Remote.clear();
    if (MP.UI) MP.UI.exitMatchUI();
    if (leavingRoom) {
      MP.Voice && MP.Voice.teardownAll();
    }
    // restore monster update semantics for SP
    MON.soundEvents.length = 0;
  };

  /* ============================================================
     interaction routing (called by the patched INTERACT actions)
     ============================================================ */

  /** patched door interaction: intents only — the server decides */
  GM.onDoorInteract = function (d) {
    if (!GM.canAct()) return;
    const def = d.def;
    G.player.triggerHandAnim();
    if (def.type === 'keycard') {
      if (d.unlocked) { GM.toggleDoor(d); return; }
      if (G.inv.has('keycard')) GM.requestEvent('unlock', { key: d.key, method: 'keycard' });
      else { AUD.play('errorBuzz'); UI.toast('The reader blinks red. LEVEL 1 ACCESS REQUIRED.'); }
      return;
    }
    if (def.type === 'powered') {
      if (!d.unlocked) {
        AUD.play('errorBuzz');
        UI.toast('The blast door is dead. No power. The electrical room might help.');
        STORY.hintPower();
      } else GM.toggleDoor(d);
      return;
    }
    if (def.type === 'code') {
      if (d.unlocked) { GM.toggleDoor(d); return; }
      UI.openKeypad(d);
      return;
    }
    if (def.type === 'elevator') {
      if (d.unlocked) GM.toggleDoor(d);
      else UI.toast('The gate is cold. No power reaches the elevator.');
      return;
    }
    GM.toggleDoor(d);
  };

  GM.toggleDoor = function (d) {
    GM.requestEvent('door', { key: d.key, open: !d.open }, {
      onRejected: (res) => {
        if (res && res.error === 'door is locked') { AUD.play('errorBuzz'); UI.toast('It will not budge. Locked.'); }
      },
    });
  };

  /** patched keypad ENTER: the server knows the real code and decides */
  GM.onKeypadEnter = function (door) {
    GM.requestEvent('unlock', { key: door.key, method: 'code', code: String(UI._keyInput || '') });
    AUD.play('keypad', {});
  };

  /** patched pickup action */
  GM.onPickupInteract = function (it) {
    if (!GM.canAct()) return;
    G.player.triggerHandAnim();
    GM.requestEvent('pickup', { id: it.id });
  };

  /** patched frequency-lock: server confirms calibration */
  GM.onFreqLock = function () {
    if (G.state.flags.calibrated) return;
    if (GM._freqLockCooldown) return;
    GM._freqLockCooldown = true;
    setTimeout(() => { GM._freqLockCooldown = false; }, 2500);
    GM.requestOnce('calibrated', null);
  };

  /* ============================================================
     inspection helpers
     ============================================================ */

  GM.hiderAt = function (spot) {
    const idx = WORLD.hideSpots.indexOf(spot);
    return GM.allPlayerStates().find(p => p.hidden && p.spotIdx === idx) || null;
  };

  /** patched inspectFail handler in MP. Returns true when the event is
   *  consumed here (remote hider -> kill reported to the server; empty
   *  spot -> nothing to force out). Returns false for the LOCAL hider so
   *  the original forceOut path runs (patched startDeath gate reports). */
  GM.onInspectFailMp = function (spot) {
    const st = GM.hiderAt(spot);
    HIDE.cues = false;
    UI.hideWarning(false);
    if (!st) return true;                       // wrong locker: no local force-out
    if (st.local) return false;                 // me: original forceOut -> startDeath gate
    GM.reportKill(st.id, 'hidefail');
    return true;
  };

  /** patched fake-out reveal timeout: remote hiders are grabbed via the server */
  GM.fakeoutRevealGrab = function (spot) {
    if (!MP.active || !MP.isSimHost) return false;   // not handled here
    const st = GM.hiderAt(spot);
    if (!st) return false;
    if (st.local) return false;                      // local: original path runs
    if (st.downed || !st.hidden) { MON.setState('hunt', 'fakeout'); return true; }
    GM.reportKill(st.id, 'hidefail');
    return true;
  };

  /* ============================================================
     simulation host: creature proxy targeting
     ============================================================ */

  GM._makeProxy = function () {
    const camPos = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const proxy = {
      mpId: null,
      camera: {
        position: camPos,
        getWorldDirection: (v) => { v.set(-Math.sin(proxy.yaw), 0, -Math.cos(proxy.yaw)); return v; },
        fov: 72,
      },
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: 0, pitch: 0,
      height: 1.62,
      crouching: false, sprinting: false, hidden: false, dead: false,
      hideSpot: null, hideLimits: null,
      stamina: 100, exhausted: false,
      battery: 100, flashlightOn: false, hasFlashlight: true,
      beamHitsMonster: false, moveSpeedCur: 0, noiseWhileHidden: false,
      lastVisiblePos: null, controlLocked: false,
      shake: () => {},
      triggerHandAnim: () => {},
      startDeath: function (reason) { GM.reportKill(proxy.mpId, reason); },
      toggleFlashlight: () => {},
      useBattery: () => {},
      look: () => {},
      respawn: () => {},
    };
    return proxy;
  };

  GM.allPlayerStates = function () {
    // local player + remote snapshots, skipping downed/dead
    const out = [];
    const pl = G.player;
    if (pl && !pl.dead && !GM.iAmDowned) {
      out.push({ id: MP.playerId, x: pl.pos.x, z: pl.pos.z, yaw: pl.yaw, hidden: !!pl.hidden, crouch: !!pl.crouching, downed: false, local: true, spotIdx: pl.hidden && pl.hideSpot ? WORLD.hideSpots.indexOf(pl.hideSpot) : -1, flash: pl.flashlightOn && pl.hasFlashlight && pl.battery > 0 });
    }
    for (const [pid, e] of MP.Remote.players) {
      const m = MP.members.find(x => x.id === pid);
      const downed = !!(m && m.downed) || e.downed;
      out.push({ id: pid, x: e.draw.x, z: e.draw.z, yaw: e.draw.yaw, hidden: e.hidden, crouch: e.crouch, downed, local: false, spotIdx: e.spotIdx === undefined ? -1 : e.spotIdx, flash: e.flash, speed: e.speed });
    }
    return out;
  };

  GM.pickProxyTarget = function () {
    if (!GM._proxy) GM._proxy = GM._makeProxy();
    const proxy = GM._proxy;
    const cands = GM.allPlayerStates().filter(p => !p.downed);
    if (!cands.length) { GM._proxyTarget = null; return null; }

    // scoring: visible-and-close wins; otherwise nearest; hysteresis on the current target
    let best = null, bestScore = -1e9;
    const cur = GM._proxyTarget;
    for (const c of cands) {
      const d = Math.hypot(MON.pos.x - c.x, MON.pos.z - c.z);
      let score = -d;
      const vis = GM.canSeeFrom(c);
      if (vis) score += 60 - d * 0.5;
      if (c.hidden) score -= 25;
      if (c.flash && d < 20) score += 8;
      if (cur && c.id === cur.id) score += 8;           // stickiness
      if (MON.aggroLock && MON.lastKnown) {
        const dk = Math.hypot(MON.lastKnown.x - c.x, MON.lastKnown.z - c.z);
        score += Math.max(0, 12 - dk);                    // whoever is near last known position
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    GM._proxyTarget = best;

    // fill the proxy from the chosen player's latest state
    proxy.mpId = best.id;
    const eye = best.crouch ? 1.02 : 1.62;
    proxy.pos.set(best.x, 0, best.z);
    proxy.camera.position.set(best.x, eye, best.z);
    proxy.yaw = best.yaw; proxy.pitch = 0;
    proxy.crouching = best.crouch; proxy.sprinting = !!(best.speed > 3.5);
    proxy.hidden = !!best.hidden; proxy.dead = false;
    proxy.hideSpot = best.hidden && best.spotIdx >= 0 ? (WORLD.hideSpots[best.spotIdx] || null) : null;
    proxy.moveSpeedCur = best.local ? (G.player ? G.player.moveSpeedCur : 0) : (best.speed || 0);
    proxy.flashlightOn = !!best.flash; proxy.battery = 60; proxy.hasFlashlight = !!best.flash || best.local;
    proxy.noiseWhileHidden = best.local && G.player ? !!G.player.noiseWhileHidden : false;
    if (best.local && G.player) {
      proxy.stamina = G.player.stamina; proxy.lastVisiblePos = G.player.lastVisiblePos;
      proxy.beamHitsMonster = G.player.beamHitsMonster;
    } else {
      // approximate beam-hits-monster for remote flashlight holders
      if (best.flash) {
        const dx = MON.pos.x - best.x, dz = MON.pos.z - best.z;
        const dist = Math.hypot(dx, dz) || 1;
        const fdx = -Math.sin(best.yaw), fdz = -Math.cos(best.yaw);
        const dot = (dx / dist) * fdx + (dz / dist) * fdz;
        proxy.beamHitsMonster = dist < 18 && dot > 0.965 && WORLD.hasLOS(best.x, best.z, MON.pos.x, MON.pos.z);
      } else proxy.beamHitsMonster = false;
      if (!best.hidden && proxy.moveSpeedCur > 0.5) proxy.lastVisiblePos = new THREE.Vector3(best.x, 0, best.z);
    }
    return proxy;
  };

  GM.canSeeFrom = function (c) {
    if (c.hidden) return false;
    const dx = c.x - MON.pos.x, dz = c.z - MON.pos.z;
    const dist = Math.hypot(dx, dz);
    let viewDist = 13 * (MON.diff.visionMul || 1);
    if (c.flash) viewDist += 6;
    if (c.crouch) viewDist *= 0.65;
    if (dist > viewDist) return false;
    const toP = Math.atan2(dx, dz);
    const diff = Math.abs(angleDiff(MON.yaw, toP));
    if (diff > 1.05 && dist > 2.2) return false;
    return WORLD.hasLOS(MON.pos.x, MON.pos.z, c.x, c.z);
  };

  /* ---------------- monster snapshot stream (sim host -> server) ---------------- */

  GM.sendMonster = function () {
    if (!MP.isSimHost || !MP.active) return;
    GM.sendAcc += 1;
    const now = performance.now();
    if (now - (GM._lastSend || 0) < 100) return;   // 10Hz
    GM._lastSend = now;
    void GM.sendAcc;
    MP.Net.sendMonster({
      x: +MON.pos.x.toFixed(2), z: +MON.pos.z.toFixed(2), yaw: +MON.yaw.toFixed(3),
      st: MON.state, sp: +Math.min(9, MON.speed || 0).toFixed(2),
      act: !!MON.active, gl: !!MON.glimpseMode, ag: !!MON.aggroLock,
      isp: MON.state === 'inspect' && MON.inspectSpot ? WORLD.hideSpots.indexOf(MON.inspectSpot) : -1,
      iph: MON.inspectPhase || '', lt: +((MON.lungeT || 0).toFixed ? MON.lungeT.toFixed(2) : 0),
      tid: GM._proxyTarget ? GM._proxyTarget.id : null,
      susp: +MON.suspicion.toFixed(2),
    });
  };

  GM.onMonsterSnapshot = function (m) {
    if (!m) return;
    GM.lastMonster = m;
    GM.monsterRecvT = performance.now();
  };

  /** non-sim clients: drive the creature visuals from validated server snapshots */
  GM.driveMonsterFromNet = function (dt) {
    const m = GM.lastMonster;
    if (!MON.model) return;
    if (!m) { MON.model.visible = false; return; }
    // interpolate toward the snapshot
    const tx = m.x, tz = m.z;
    MON.pos.x += (tx - MON.pos.x) * Math.min(1, dt * 14);
    MON.pos.z += (tz - MON.pos.z) * Math.min(1, dt * 14);
    MON.yaw += angleDiff(MON.yaw, m.yaw) * Math.min(1, dt * 12);
    MON.speed = m.sp || 0;
    MON.active = !!m.act; MON.glimpseMode = !!m.gl; MON.aggroLock = !!m.ag;
    if (m.susp !== undefined) MON.suspicion = m.susp;
    if (MON.state !== m.st) MON.setState(m.st);
    MON.inspectPhase = m.iph || null;
    MON.inspectSpot = (m.isp >= 0 && WORLD.hideSpots[m.isp]) ? WORLD.hideSpots[m.isp] : null;
    MON.lungeT = m.lt || 0;
    // approximate "it sees me" for the local fear systems when the creature is locked onto me
    MON.seesPlayer = !!(m.tid && m.tid === MP.playerId && (m.st === 'hunt' || m.st === 'stalk' || m.st === 'attack' || m.st === 'inspect'));
    MON.model.visible = (MON.active || MON.glimpseMode || MON.state === 'attack');
    MON.model.position.set(MON.pos.x, 0, MON.pos.z);
    MON.model.rotation.y = MON.yaw;
    // full original animation & positional audio — every client sees/hears the same creature
    const pl = G.player;
    const playerDist = pl ? Math.hypot(MON.pos.x - pl.pos.x, MON.pos.z - pl.pos.z) : 99;
    // neutralize the attack-lunge displacement unless WE are the target (it moves MON.pos)
    const lungeGuard = (MON.state === 'attack' || MON.inspectPhase === 'kill') && m.tid && m.tid !== MP.playerId;
    const savedLunge = MON.lungeT;
    if (lungeGuard) MON.lungeT = 0.9;
    try {
      MON._animate(dt, playerDist);
      MON._audio(dt, playerDist);
    } catch (e) { /* never break the loop */ }
    if (lungeGuard) MON.lungeT = savedLunge;
    // staleness: if the sim host stopped reporting, freeze in place (no fake AI)
    if (performance.now() - GM.monsterRecvT > 4000) MON.model.visible = false;
  };

  /** new sim host (match start or migration): adopt the last known monster state */
  GM.adoptMonsterAsSimHost = function (m) {
    if (!m) return;
    MON.pos.set(m.x, 0, m.z);
    MON.model.position.copy(MON.pos);
    MON.yaw = m.yaw || 0;
    MON.active = !!m.act; MON.glimpseMode = !!m.gl; MON.aggroLock = !!m.ag;
    MON.suspicion = m.susp || MON.suspicion;
    MON.path = null; MON.target = null; MON.pathIdx = 0;
    MON.inspectPhase = null; MON.inspectSpot = null;
    if (m.st && MON.state !== m.st) MON.setState(m.st === 'attack' ? 'hunt' : m.st);
    else if (!m.st) MON.setState('patrol');
  };

  GM.onSimRole = function (d) {
    const was = MP.isSimHost;
    MP.isSimHost = !!d.isSimHost;
    if (MP.isSimHost && !was && MP.active) {
      GM.adoptMonsterAsSimHost(d.monster || GM.lastMonster);
      UI.toast('You are now steering the facility systems. (simulation host)', 4000);
    }
    MP.emit('sim:role', d);
  };

  /* ============================================================
     inspection / skill check relay
     ============================================================ */

  /** called by the patched bus handlers on the SIM HOST.
   *  Returns true when the hider is remote (event relayed, skip local). */
  GM.relayInspect = function (etype, spot, extra) {
    if (!MP.active || !MP.isSimHost) return false;
    const idx = WORLD.hideSpots.indexOf(spot);
    const st = GM.allPlayerStates().find(p => p.hidden && p.spotIdx === idx);
    if (!st) return false;                    // nobody there — original no-op guards handle it
    if (st.local) return false;               // I am the hider: run locally
    MP.Net.sendInspect(Object.assign({ etype, target: st.id, spotIdx: idx }, extra || {}));
    return true;
  };

  /** victim client: inspection cues relayed from the sim host */
  GM.onInspectRelay = function (d) {
    if (!MP.active || !d) return;
    const spot = (d.spotIdx >= 0 && WORLD.hideSpots[d.spotIdx]) ? WORLD.hideSpots[d.spotIdx] : (G.player && G.player.hideSpot);
    if (!spot) return;
    switch (d.etype) {
      case 'windup': G.bus.emit('inspectWindup', spot); break;
      case 'check':
        GM.skillPending = true;
        SKILL.start(d.diff || 'hard', spot);
        break;
      case 'success': G.bus.emit('inspectSuccess', { spot, second: !!d.second }); break;
      case 'fake_leave': G.bus.emit('fakeoutLeave', spot); break;
      case 'fake_safe': G.bus.emit('fakeoutSafe', spot); break;
      case 'fake_reveal':
        G.bus.emit('fakeoutReveal', spot);
        AUD.setSilence(true); setTimeout(() => AUD.setSilence(false), 900);
        MAIN.addStatic(0.55, 0.8);
        if (G.player) G.player.shake(0.09);
        setTimeout(() => { UI.monCaption('I SEE YOU'); AUD.play('iseeyou', { vol: 0.9 }); MAIN.addStatic(0.8, 1.0); }, 700);
        break;
      case 'caption': if (d.text) UI.monCaption(d.text); break;
      default: break;
    }
  };

  /** patched SKILL.finish calls this instead of MON.onSkillResult when in MP */
  GM.routeSkillResult = function (success) {
    if (MP.isSimHost) {
      // local AI consumes it directly; server still validates any resulting kill
      GM.skillPending = false;
      MON.onSkillResult(success);
      MP.Net.sendSkillResult(success);       // informational for the record
      return true;
    }
    GM.skillPending = false;
    MP.Net.sendSkillResult(success);          // -> server -> sim host
    return true;
  };

  GM.onSkillResultRelay = function (d) {
    if (!MP.active || !MP.isSimHost || !d) return;
    MON.onSkillResult(!!d.success);
  };

  /* ============================================================
     downs / revives / wipes / rewind
     ============================================================ */

  /** sim host: the creature's proxy "died" — report to the server, which validates */
  GM.reportKill = function (targetId, reason) {
    if (!targetId) return;
    MP.Net.sendDownRequest(targetId, reason === 'hidefail' ? 'hidefail' : 'caught', (res) => {
      if (res && !res.ok) console.info('[MP] kill rejected by server:', res.error);
    });
  };

  /** patched Player.startDeath gate: in MP you only die when the SERVER says so */
  GM.localDeathRequested = function (reason) {
    if (!MP.active) return false;               // SP: proceed as normal
    if (MP.applying || GM._deathApproved) return false;  // server-confirmed: proceed
    // queue it — ask the server
    GM.pendingDeath = reason;
    MP.Net.sendDownRequest(MP.playerId, reason === 'hidefail' ? 'hidefail' : 'caught', (res) => {
      if (res && !res.ok) {
        // server refused the death (e.g. monster out of range): survive and recover
        GM.pendingDeath = null;
        try {
          G.player.controlLocked = false;
          if (HIDE.phase === 'forced') { HIDE.phase = 'inside'; }
          UI.toast('You tear yourself loose. It did not quite have you.', 4000);
        } catch (e) { /* ignore */ }
      }
    });
    return true;                                // caller must NOT proceed yet
  };

  GM.onPlayerDowned = function (d) {
    if (!d) return;
    const member = MP.members.find(m => m.id === d.player);
    if (member) member.downed = true;
    if (d.player === MP.playerId) {
      GM.iAmDowned = true;
      GM._deathApproved = true;
      try {
        if (d.reason === 'hidefail' && HIDE.phase === 'inside') {
          HIDE.forceOut();      // ripped out of the locker, then startDeath runs (approved)
        } else {
          G.player.startDeath(d.reason === 'hidefail' ? 'hidefail' : 'caught', MON);
        }
      } finally {
        // _deathApproved stays true through the sequence; startDeath already flipped dead=true
        setTimeout(() => { GM._deathApproved = false; }, 1500);
      }
      // the downed overlay replaces the SP death screen (UI.deathScreen is patched)
    } else {
      const name = (MP.members.find(m => m.id === d.player) || {}).name || 'A survivor';
      UI.toast(`${name} was taken down. Reach them in time — hold [E] to revive.`, 5200);
      AUD.play('subThump', { vol: 0.4 });
    }
    MP.emit('mp:downed', d);
    if (MP.UI) MP.UI.refreshTeamPanel();
  };

  GM.onPlayerRevived = function (d) {
    if (!d) return;
    const member = MP.members.find(m => m.id === d.player);
    if (member) member.downed = false;
    if (d.player === MP.playerId) {
      GM.iAmDowned = false;
      MP.applying = true;
      try {
        $('deathScreen').classList.remove('on');
        if (MP.UI) MP.UI.hideDowned();
        const at = Array.isArray(d.at) ? d.at : null;
        const x = at ? at[0] : (G.state.checkpoint ? cw(G.state.checkpoint.gx - 0.5) + CELL / 2 : G.player.pos.x);
        const z = at ? at[1] : (G.state.checkpoint ? cw(G.state.checkpoint.gy - 0.5) + CELL / 2 : G.player.pos.z);
        const o = WORLD.nearestOpen ? (WORLD.nearestOpen(x, z, 3) || { x, z }) : { x, z };
        G.player.respawn(o.x, o.z, G.player.yaw);
        G.player.stamina = 60;
        G.state.scene = 'play';
        AUD.setMuffled(false, 0.2);
        AUD.music.stop();
        UI.fearVignette(0);
        UI.toast('Hands pull you back from the edge. Breathe. Move.', 4500);
        MAIN.requestLock();
      } finally { MP.applying = false; }
    } else {
      const name = (MP.members.find(m => m.id === d.player) || {}).name || 'A survivor';
      UI.toast(`${name} is back on their feet.`, 3500);
    }
    MP.emit('mp:revived', d);
    if (MP.UI) MP.UI.refreshTeamPanel();
  };

  GM.onReviveProgress = function (d) {
    if (!d) return;
    if (MP.UI) MP.UI.reviveProgress(d);
  };

  /* revive hold: patched prompt + E-hold tracking */
  GM.updatePrompts = function () {
    if (!MP.active || GM.iAmDowned || !G.player || G.player.dead) { GM.reviveFocus = null; return; }
    // nearest downed teammate within range
    let best = null, bd = 3.0;
    for (const m of MP.members) {
      if (m.id === MP.playerId || !m.downed) continue;
      const rp = MP.Remote.posOf(m.id);
      if (!rp) continue;
      const d = Math.hypot(rp.x - G.player.pos.x, rp.z - G.player.pos.z);
      if (d < bd) { bd = d; best = m; }
    }
    GM.reviveFocus = best;
    if (best && !INTERACT.focus && !INTERACT.busy && !GM.reviveHold) {
      UI.setPrompt('REVIVE ' + (best.name || 'SURVIVOR'), 'HOLD [E] — do not let go');
    }
  };

  GM.startReviveHold = function () {
    if (!GM.reviveFocus || GM.reviveHold) return;
    GM.reviveHold = { target: GM.reviveFocus.id, t: 0, tick: 0 };
    INTERACT.busy = true;
  };

  GM.updateReviveHold = function (dt) {
    const h = GM.reviveHold;
    if (!h) return;
    const target = MP.members.find(m => m.id === h.target);
    const rp = MP.Remote.posOf(h.target);
    const d = (rp && G.player) ? Math.hypot(rp.x - G.player.pos.x, rp.z - G.player.pos.z) : 99;
    if (!target || !target.downed || d > 3.4 || !G.input || !GM._eDown) { GM.endReviveHold(); return; }
    h.t += dt;
    h.tick += dt;
    if (h.tick > 0.25) { h.tick = 0; MP.Net.sendReviveTick(h.target); }
    UI.setPrompt('REVIVING ' + (target.name || ''), `${Math.min(100, Math.round(h.t / 3 * 100))}% — keep holding [E]`);
  };

  GM.endReviveHold = function () {
    if (!GM.reviveHold) return;
    GM.reviveHold = null;
    INTERACT.busy = false;
  };

  GM.onTeamWipe = function () {
    if (GM.wipeShown) return;
    GM.wipeShown = true;
    GM.iAmDowned = false;
    AUD.music.stop();
    AUD.play('deepBoom', { vol: 0.9 });
    // show the death screen in TEAM WIPE mode (buttons rewired by UI)
    G.state.scene = 'dead';
    $('deathCause').textContent = 'Every signal in the facility has gone quiet. It keeps what it catches — all of you, this time.';
    $('deathScreen').classList.add('on');
    document.exitPointerLock && document.exitPointerLock();
    if (MP.UI) MP.UI.armWipeButtons();
  };

  GM.requestRewind = function () { MP.Net.sendRewindRequest(); };

  GM.applyRewind = function (d) {
    MP.applying = true;
    try {
      GM.wipeShown = false;
      GM.iAmDowned = false;
      GM._deathApproved = true;
      // prefer the server's authoritative checkpoint (a mid-match joiner's
      // local copy may predate the last CHECKPOINT broadcast)
      if (d && d.checkpoint && d.checkpoint.gx != null) {
        G.state.checkpoint = {
          chapter: G.state.chapter, campaign: MP.campaign,
          gx: +d.checkpoint.gx, gy: +d.checkpoint.gy, yaw: +d.checkpoint.yaw || 0,
        };
      }
      $('deathScreen').classList.remove('on');
      if (MP.UI) MP.UI.hideDowned();
      G.player.respawn(
        cw((G.state.checkpoint || MAP.checkpoints[1]).gx - 0.5) + CELL / 2,
        cw((G.state.checkpoint || MAP.checkpoints[1]).gy - 0.5) + CELL / 2,
        (G.state.checkpoint || MAP.checkpoints[1]).yaw || 0);
      MAIN.restartCheckpoint();
      G.player.dead = false;
      UI.toast('The signal rewinds. All of you are standing at the last checkpoint. It remembers.', 5200);
      setTimeout(() => { GM._deathApproved = false; }, 1000);
    } finally { MP.applying = false; }
  };

  /* ============================================================
     milestone persistence (never per-tick)
     ============================================================ */

  GM.saveSessionMilestone = function (kind, payload) {
    if (!MP.Auth.user) return;
    MP.Auth.saveMilestone(Object.assign({ stats: {} }, payload || {}));
    void kind;
  };
})();
