/* ============================================================
   THE LAST SIGNAL — multiplayer client: WebRTC proximity voice
   ------------------------------------------------------------
   Real peer-to-peer audio (never routed through Supabase or the
   game server's data path — the server only relays SDP/ICE
   signaling between members of the SAME room).

   - mesh topology (max 6 players => max 5 remote streams)
   - proximity model: per-peer GainNode attenuated by world
     distance + StereoPannerNode oriented by the local player's
     yaw — voices fade and pan as survivors move apart
   - self mute/unmute, per-player mute, mic permission flow with
     clear status, speaking indicators, join/leave handling,
     reconnection, and full cleanup on room leave
   - ICE: public STUN by default; TURN is requested from the
     server at runtime (credentials stay in server env vars)
   ============================================================ */
(function () {
  'use strict';

  const EV = LS_NET.EV;

  const V = MP.Voice = {
    enabled: false,          // mic permission granted & streaming
    muted: false,            // self-mute
    status: 'off',           // off | requesting | on | muted | error | unsupported
    statusMsg: '',
    localStream: null,
    pcs: new Map(),          // playerId -> {pc, audioEl?, gain, panner, analyser, stream, speaking, mutedByMe}
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    ctx: null,
    master: null,
    speakingLocal: false,
    localLevel: 0,
    lastProximityT: 0,
    perPlayerMutes: new Set(),
  };

  const PROX_NEAR = 3.5;     // full volume inside this distance (meters)
  const PROX_FAR = 24;       // silent beyond this
  const PROX_MIN_GAIN = 0.0;

  function setStatus(s, msg) {
    V.status = s; V.statusMsg = msg || '';
    MP.emit('voice:status', { status: s, msg: V.statusMsg });
  }

  V.isAvailable = function () {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  function ensureCtx() {
    if (!V.ctx) {
      V.ctx = new (window.AudioContext || window.webkitAudioContext)();
      V.master = V.ctx.createGain();
      V.master.gain.value = 1.0;
      V.master.connect(V.ctx.destination);
    }
    if (V.ctx.state === 'suspended') V.ctx.resume().catch(() => {});
    return V.ctx;
  }

  /* ---------------- mic permission flow ---------------- */

  V.enableMic = async function () {
    if (!V.isAvailable()) { setStatus('unsupported', 'This browser does not support WebRTC voice.'); return false; }
    if (V.enabled) return true;
    setStatus('requesting', 'Requesting microphone access...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      V.localStream = stream;
      V.enabled = true;
      V.muted = false;
      _applyTrackEnabled();
      _attachLocalAnalyser();
      // tell the room we are on voice; server responds with the peer list + ICE config
      await V._hello();
      setStatus(V.muted ? 'muted' : 'on', V.muted ? 'Microphone muted.' : 'Microphone live.');
      return true;
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') setStatus('error', 'Microphone permission denied. Allow mic access in your browser settings, then retry.');
      else if (name === 'NotFoundError') setStatus('error', 'No microphone found.');
      else setStatus('error', 'Microphone failed: ' + (e && e.message || name));
      return false;
    }
  };

  V.disableMic = function () {
    V.teardownAll('mic off');
    if (V.localStream) { V.localStream.getTracks().forEach(t => t.stop()); V.localStream = null; }
    V.enabled = false; V.muted = false;
    MP.Net.emitRaw(EV.VOICE_STATE, { mic: 'off' });
    setStatus('off', 'Microphone off.');
  };

  V.toggleMute = function () {
    if (!V.enabled) return V.enableMic();
    V.muted = !V.muted;
    _applyTrackEnabled();
    MP.Net.emitRaw(EV.VOICE_STATE, { mic: V.muted ? 'muted' : 'on' });
    setStatus(V.muted ? 'muted' : 'on', V.muted ? 'Muted — nobody can hear you.' : 'Live — the room can hear you.');
    if (window.AUD && AUD.play) AUD.play('uiBlip', { freq: V.muted ? 300 : 520 });
    return V.muted;
  };

  function _applyTrackEnabled() {
    if (!V.localStream) return;
    V.localStream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
  }

  function _attachLocalAnalyser() {
    try {
      const ctx = ensureCtx();
      if (V.localAnalyser) return;
      const src = ctx.createMediaStreamSource(V.localStream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);           // analyser only — NOT connected to destination (no self-echo)
      V.localAnalyser = an;
      V._localBuf = new Uint8Array(an.frequencyBinCount);
    } catch (e) { /* non-fatal */ }
  }

  V.togglePlayerMute = function (playerId) {
    const p = V.pcs.get(playerId);
    if (V.perPlayerMutes.has(playerId)) {
      V.perPlayerMutes.delete(playerId);
      if (p) p.mutedByMe = false;
      MP.UI && MP.UI.sysToast('Voice unmuted for that survivor.');
    } else {
      V.perPlayerMutes.add(playerId);
      if (p) p.mutedByMe = true;
      MP.UI && MP.UI.sysToast('Voice muted for that survivor.');
    }
    MP.emit('voice:mutes', [...V.perPlayerMutes]);
  };

  /* ---------------- peer mesh ---------------- */

  async function ensureIce() {
    try {
      const s = MP.Net.socket;
      if (!s) return;
      const res = await new Promise((resolve) => s.timeout(6000).emit(EV.VOICE_ICE_REQUEST, {}, (err, r) => resolve(err ? null : r)));
      if (res && res.ok && Array.isArray(res.iceServers) && res.iceServers.length) {
        V.iceServers = res.iceServers;
        V.turnConfigured = !!res.turn;
        if (!res.turn) console.info('[MP.voice] no TURN configured on server — players behind strict NATs may not connect voice. Set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL in server .env.');
      }
    } catch (e) { /* keep STUN default */ }
  }

  V._hello = function () {
    return new Promise((resolve) => {
      const s = MP.Net.socket;
      if (!s || !s.connected) return resolve();
      s.timeout(6000).emit(EV.VOICE_HELLO, { mic: V.muted ? 'muted' : 'on' }, async (err, res) => {
        if (err || !res || !res.ok) return resolve();
        if (Array.isArray(res.iceServers) && res.iceServers.length) {
          V.iceServers = res.iceServers;
          V.turnConfigured = !!res.turn;
          if (!res.turn) console.info('[MP.voice] no TURN configured on server — players behind strict NATs may not connect voice. Set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL in the server environment.');
        }
        await V.onPeers({ peers: res.peers || [] });
        resolve();
      });
    });
  };

  V.onPeers = async function (d) {
    if (!V.enabled || !d || !Array.isArray(d.peers)) return;
    await ensureIce();
    for (const peer of d.peers) {
      if (peer.id === MP.playerId) continue;
      await V._ensurePeer(peer.id, peer.name);
    }
  };

  V._ensurePeer = async function (peerId, name) {
    if (!V.enabled || V.pcs.has(peerId)) return V.pcs.get(peerId);
    const ctx = ensureCtx();
    const pc = new RTCPeerConnection({ iceServers: V.iceServers });
    const entry = { pc, name: name || peerId.slice(0, 6), gain: null, panner: null, analyser: null, stream: null, speaking: false, mutedByMe: V.perPlayerMutes.has(peerId), lastRecv: 0 };

    // build the proximity audio chain lazily when the remote stream arrives
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      entry.stream = stream;
      try {
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 512;
        const g = ctx.createGain(); g.gain.value = entry.mutedByMe ? 0 : 1;
        let pan = null;
        if (ctx.createStereoPanner) { pan = ctx.createStereoPanner(); pan.pan.value = 0; }
        src.connect(an);
        if (pan) { an.connect(g); g.connect(pan); pan.connect(V.master); }
        else { an.connect(g); g.connect(V.master); }
        entry.analyser = an; entry.gain = g; entry.panner = pan;
        entry._buf = new Uint8Array(an.frequencyBinCount);
      } catch (err) { console.warn('[MP.voice] audio chain failed', err); }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) MP.Net.emitRaw(EV.VOICE_SIGNAL, { to: peerId, data: { type: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } });
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // attempt one ICE restart on failure
        if (pc.connectionState === 'failed' && entry._restarted !== true) {
          entry._restarted = true;
          try { pc.restartIce(); } catch (e) { V._removePeer(peerId); }
        } else if (pc.connectionState === 'failed') {
          V._removePeer(peerId);
        }
      }
      MP.emit('voice:peerstate', { id: peerId, state: pc.connectionState });
    };

    if (V.localStream) for (const t of V.localStream.getAudioTracks()) pc.addTrack(t, V.localStream);

    V.pcs.set(peerId, entry);

    // deterministic offerer: lexicographically greater player id creates the offer
    if (String(MP.playerId) > String(peerId)) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        MP.Net.emitRaw(EV.VOICE_SIGNAL, { to: peerId, data: { type: 'offer', sdp: pc.localDescription.sdp } });
      } catch (e) { console.warn('[MP.voice] offer failed', e); }
    }
    return entry;
  };

  V.onSignal = async function (d) {
    if (!V.enabled || !d || !d.from || !d.data) return;
    const entry = await V._ensurePeer(d.from, d.name);
    if (!entry) return;
    const pc = entry.pc;
    try {
      if (d.data.type === 'offer') {
        if (pc.signalingState !== 'stable') return;
        await pc.setRemoteDescription({ type: 'offer', sdp: d.data.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        MP.Net.emitRaw(EV.VOICE_SIGNAL, { to: d.from, data: { type: 'answer', sdp: pc.localDescription.sdp } });
      } else if (d.data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp: d.data.sdp });
      } else if (d.data.type === 'ice') {
        if (d.data.candidate) await pc.addIceCandidate(d.data.candidate).catch(() => {});
      }
    } catch (e) { console.warn('[MP.voice] signal handling failed', e); }
  };

  V.onPeerLeft = function (d) {
    if (!d || !d.id) return;
    V._removePeer(d.id);
  };

  V._removePeer = function (peerId) {
    const e = V.pcs.get(peerId);
    if (!e) return;
    try { e.pc.close(); } catch (_) {}
    V.pcs.delete(peerId);
    MP.emit('voice:peerstate', { id: peerId, state: 'removed' });
  };

  V.onPeerMicState = function (d) {
    if (!d || !d.id) return;
    const m = MP.members.find(x => x.id === d.id);
    if (m) m.mic = d.mic;
    MP.emit('voice:peerstate', { id: d.id, mic: d.mic });
    if (MP.UI) MP.UI.refreshTeamPanel();
  };

  V.teardownAll = function () {
    for (const id of [...V.pcs.keys()]) V._removePeer(id);
  };

  /* ---------------- proximity mixing (called ~every frame; throttled) ---------------- */

  V.updateProximity = function (dt) {
    const now = performance.now();
    // speaking indicators (cheap, per frame at ~10Hz)
    if (now - V.lastProximityT < 100) return;
    V.lastProximityT = now;

    // local speaking level
    if (V.localAnalyser && V.enabled && !V.muted) {
      V.localAnalyser.getByteTimeDomainData(V._localBuf);
      let sum = 0;
      for (let i = 0; i < V._localBuf.length; i += 4) { const v = (V._localBuf[i] - 128) / 128; sum += v * v; }
      V.localLevel = Math.sqrt(sum / (V._localBuf.length / 4));
      const sp = V.localLevel > 0.055;
      if (sp !== V.speakingLocal) { V.speakingLocal = sp; MP.emit('voice:speaking', { id: MP.playerId, speaking: sp }); }
    }

    const pl = G.player;
    const havePos = pl && MP.active;
    const lx = havePos ? pl.pos.x : 0, lz = havePos ? pl.pos.z : 0, lyaw = havePos ? pl.yaw : 0;

    for (const [pid, e] of V.pcs) {
      // speaking detection
      if (e.analyser && e.stream) {
        e.analyser.getByteTimeDomainData(e._buf);
        let sum = 0;
        for (let i = 0; i < e._buf.length; i += 4) { const v = (e._buf[i] - 128) / 128; sum += v * v; }
        const lvl = Math.sqrt(sum / (e._buf.length / 4));
        const sp = lvl > 0.045;
        if (sp !== e.speaking) { e.speaking = sp; MP.emit('voice:speaking', { id: pid, speaking: sp }); }
      }
      if (!e.gain) continue;

      // proximity: full volume near, linear fade to silence at PROX_FAR, panned by relative bearing
      let targetGain = e.mutedByMe ? 0 : 1;
      let pan = 0;
      if (havePos) {
        const rp = MP.Remote.posOf(pid);
        const member = MP.members.find(m => m.id === pid);
        const downed = member && member.downed;
        if (!rp || downed) {
          targetGain = 0;                       // no position (not spawned) or downed: silent
        } else {
          const dx = rp.x - lx, dz = rp.z - lz;
          const d = Math.hypot(dx, dz);
          if (d <= PROX_NEAR) targetGain = e.mutedByMe ? 0 : 1;
          else if (d >= PROX_FAR) targetGain = PROX_MIN_GAIN;
          else targetGain = e.mutedByMe ? 0 : 1 - (d - PROX_NEAR) / (PROX_FAR - PROX_NEAR);
          // bearing: local forward is (-sin yaw, -cos yaw); right vector is (cos? ) compute cross product
          if (e.panner && d > 0.4) {
            const fx = -Math.sin(lyaw), fz = -Math.cos(lyaw);
            const rx = -fz, rz = fx;                    // right = forward rotated -90°
            pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d));
          }
          // hidden players are muffled, not silent (they can still whisper)
          if (member && member.hidden) targetGain *= 0.55;
        }
      }
      // smooth
      const cur = e.gain.gain.value;
      e.gain.gain.value = cur + (targetGain - cur) * 0.25;
      if (e.panner) {
        const cp = e.panner.pan.value;
        e.panner.pan.value = cp + (pan - cp) * 0.25;
      }
    }
  };

  /** Called when the socket (re)connects while we are in a room with mic on. */
  V.resync = async function () {
    if (!V.enabled) return;
    V.teardownAll();
    MP.Net.emitRaw(EV.VOICE_STATE, { mic: V.muted ? 'muted' : 'on' });
    await V._hello();
  };

  V.peerCount = function () { return V.pcs.size; };
  V.connectedCount = function () { let n = 0; for (const [, e] of V.pcs) if (e.pc.connectionState === 'connected') n++; return n; };
})();
