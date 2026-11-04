/* ============================================================
   THE LAST SIGNAL — multiplayer client: Socket.IO network layer
   ------------------------------------------------------------
   - connects to the authoritative game server with the player's
     Supabase access token (validated server-side; identity can
     never be spoofed by editing a client-side id)
   - room create/join/leave/ready/start + live room list
   - movement sender (15Hz), player/monster snapshot receiver
   - routes server-authoritative gameplay events to MP.Game
   - routes WebRTC signaling to MP.Voice
   - full connection-state reporting: CONNECTING / CONNECTED /
     RECONNECTING / DISCONNECTED / FAILED with human messages
   ============================================================ */
(function () {
  'use strict';

  const EV = LS_NET.EV, F = LS_NET.F, CONN = LS_NET.CONN;

  const N = MP.Net = {
    socket: null,
    conn: CONN.OFFLINE,
    connMsg: '',
    latency: 0,
    reconnectAttempts: 0,
    lastRoomCode: null,
    wantRoom: null,        // {code} to (re)join after connect
    moveAcc: 0,
    pendingAck: new Map(),
  };

  const MOVE_HZ = 15;

  function setConn(state, msg) {
    N.conn = state; N.connMsg = msg || '';
    MP.online = (state === CONN.CONNECTED);
    MP.emit('net:conn', { state, msg: N.connMsg, latency: N.latency });
  }

  N.isAvailable = function () { return typeof window.io !== 'undefined'; };

  /* ---------------- connect ---------------- */

  N.connect = async function (opts = {}) {
    if (!N.isAvailable()) {
      setConn(CONN.FAILED, 'Network library missing (vendor/socket.io.min.js). Serve the game over HTTP or restore the vendor folder.');
      return { ok: false, error: N.connMsg };
    }
    if (N.socket && (N.socket.connected || N.socket.active)) return { ok: true, already: true };

    // obtain the token for the handshake
    let token = null;
    if (opts.devGuest) {
      token = 'dev-guest:' + MP.Game.devGuestId();
    } else {
      if (!MP.Auth.user) return { ok: false, error: 'Sign in first — the game server only accepts authenticated players.' };
      token = await MP.Auth.token();
      if (!token) return { ok: false, error: 'Session expired. Please sign in again.' };
    }

    setConn(CONN.CONNECTING, 'Opening secure channel to HOLLOW-9 relay...');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

      try {
        N.socket = io(MP.serverUrl, {
          transports: ['websocket', 'polling'],
          auth: { token, name: MP.Auth.displayName ? MP.Auth.displayName() : MP.playerName },
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 800,
          reconnectionDelayMax: 6000,
          timeout: 12000,
        });
      } catch (e) {
        setConn(CONN.FAILED, 'Could not reach the game server: ' + e.message);
        return finish({ ok: false, error: e.message });
      }

      const failTimer = setTimeout(() => {
        if (!settled) {
          setConn(CONN.FAILED, 'The relay did not answer. Is the game server running? (npm start in /server, or deploy to Render and set the URL.)');
          finish({ ok: false, error: 'timeout' });
        }
      }, 15000);

      N.socket.on('connect', () => {
        N.reconnectAttempts = 0;
        setConn(CONN.CONNECTED, 'Secure channel established.');
        clearTimeout(failTimer);
        N._pingLoop();
        finish({ ok: true });
      });

      N.socket.on('connect_error', (err) => {
        const msg = String(err && err.message || err);
        if (/auth|token|session|sign in|guest/i.test(msg)) {
          setConn(CONN.FAILED, 'Authentication rejected: ' + msg);
        } else {
          N.reconnectAttempts++;
          setConn(N.reconnectAttempts > 2 ? CONN.RECONNECTING : CONN.CONNECTING,
            N.reconnectAttempts > 2 ? `Signal lost — re-establishing channel (${N.reconnectAttempts})...` : 'Connecting to relay...');
        }
        clearTimeout(failTimer);
        finish({ ok: false, error: msg });
      });

      N.socket.on('disconnect', (reason) => {
        if (reason === 'io client disconnect') { setConn(CONN.OFFLINE, 'Disconnected.'); return; }
        setConn(CONN.RECONNECTING, 'The signal dropped. Reconnecting...');
      });

      N.socket.on('reconnect', () => {
        setConn(CONN.CONNECTED, 'Channel restored.');
        // the server auto-restores room membership on reconnect; if we still
        // think we are in a room but the server forgot, rejoin by code.
        if (MP.inRoom && N.lastRoomCode && !MP.roomCode) {
          N.joinRoom(N.lastRoomCode, { quiet: true });
        }
      });

      N.socket.on('reconnect_failed', () => setConn(CONN.FAILED, 'Could not reach the relay. Check your connection or the server URL.'));

      /* ---- server -> client wiring ---- */
      N.socket.on(EV.NET_WELCOME, (d) => {
        MP.playerId = d.playerId;           // SERVER-assigned id — never client-chosen
        MP.playerName = d.name || MP.playerName;
        MP.dev = !!d.dev;
        MP.protocol = d.protocol;
        MP.emit('net:welcome', d);
      });

      N.socket.on(EV.NET_ERROR, (d) => MP.UI && MP.UI.sysToast('NET: ' + (d && d.message || 'error')));

      N.socket.on(EV.ROOM_STATE, (d) => N._onRoomState(d));
      N.socket.on(EV.ROOM_CLOSED, (d) => N._onRoomClosed(d));
      N.socket.on(EV.ROOM_KICKED, (d) => N._onRoomClosed({ reason: d && d.reason || 'kicked' }));

      N.socket.on(EV.GAME_START, (d) => MP.Game.onMatchStart(d));
      N.socket.on(EV.GAME_SNAPSHOT, (d) => MP.Game.onMatchSnapshot(d));
      N.socket.on(EV.GAME_APPLIED, (d) => MP.Game.onApplied(d));
      N.socket.on(EV.STATE_PLAYERS, (d) => MP.Remote.onSnapshot(d));
      N.socket.on(EV.STATE_MONSTER, (d) => MP.Game.onMonsterSnapshot(d));
      N.socket.on(EV.SIM_ROLE, (d) => MP.Game.onSimRole(d));
      N.socket.on(EV.GAME_INSPECT, (d) => MP.Game.onInspectRelay(d));
      N.socket.on(EV.SIM_SKILL_RESULT, (d) => MP.Game.onSkillResultRelay(d));
      N.socket.on(EV.GAME_PLAYER_DOWNED, (d) => MP.Game.onPlayerDowned(d));
      N.socket.on(EV.GAME_PLAYER_REVIVED, (d) => MP.Game.onPlayerRevived(d));
      N.socket.on(EV.GAME_REVIVE_PROGRESS, (d) => MP.Game.onReviveProgress(d));
      N.socket.on(EV.GAME_TEAM_WIPE, () => MP.Game.onTeamWipe());
      N.socket.on(EV.GAME_REWIND, (d) => MP.Game.applyRewind(d));

      // voice signaling passthrough
      N.socket.on(EV.VOICE_PEERS, (d) => MP.Voice && MP.Voice.onPeers(d));
      N.socket.on(EV.VOICE_SIGNAL, (d) => MP.Voice && MP.Voice.onSignal(d));
      N.socket.on(EV.VOICE_STATE, (d) => MP.Voice && MP.Voice.onPeerMicState(d));
      N.socket.on(EV.VOICE_PEER_LEFT, (d) => MP.Voice && MP.Voice.onPeerLeft(d));
    });
  };

  N._pingLoop = function () {
    clearInterval(N._pingT);
    N._pingT = setInterval(() => {
      if (!N.socket || !N.socket.connected) return;
      const t0 = performance.now();
      N.socket.timeout(4000).emit('net:ping2', {}, (err) => {
        if (!err) { N.latency = Math.round(performance.now() - t0); MP.emit('net:latency', N.latency); }
      });
    }, 5000);
  };

  N.disconnect = function () {
    clearInterval(N._pingT);
    if (N.socket) { try { N.socket.disconnect(); } catch (e) {} }
    N.socket = null;
    MP.online = false;
    setConn(CONN.OFFLINE, 'Disconnected.');
  };

  function requireSocket() {
    if (!N.socket || !N.socket.connected) return null;
    return N.socket;
  }

  /* ---------------- room API ---------------- */

  N.createRoom = function (opts, cb) {
    const s = requireSocket();
    if (!s) return cb && cb({ ok: false, error: 'Not connected to the game server.' });
    s.timeout(8000).emit(EV.ROOM_CREATE, opts || {}, (err, res) => {
      if (err) return cb && cb({ ok: false, error: 'Server did not answer (timeout).' });
      cb && cb(res || { ok: false, error: 'no response' });
    });
  };

  N.joinRoom = function (code, opts = {}) {
    const s = requireSocket();
    if (!s) { MP.UI && MP.UI.sysToast('Not connected to the game server.'); return; }
    N.wantRoom = { code };
    s.timeout(8000).emit(EV.ROOM_JOIN, { code }, (err, res) => {
      if (err) { MP.UI && MP.UI.sysToast('Server did not answer (timeout).'); return; }
      if (!res || !res.ok) {
        N.wantRoom = null;
        if (!opts.quiet && MP.UI) MP.UI.sysToast((res && res.error) || 'Could not join that room.');
        MP.emit('room:joinFailed', res);
        return;
      }
      N.lastRoomCode = res.code;
      MP.inRoom = true;
      MP.roomCode = res.code;
      if (res.snapshot) MP.Game.onMatchSnapshot(res.snapshot, { joined: true });
      if (MP.UI) MP.UI.onJoinedRoom(res);
    });
  };

  N.leaveRoom = function () {
    const s = N.socket;
    const code = MP.roomCodeSaved || MP.roomCode;
    N.wantRoom = null;
    if (s && s.connected) s.emit(EV.ROOM_LEAVE, {});
    const wasActive = MP.active;
    MP.Game.leaveMatch(true);
    MP.inRoom = false; MP.roomCode = null; N.lastRoomCode = null; MP.roomCodeSaved = null;
    if (wasActive && G.state.scene !== 'menu') { MAIN.toMenu(); }
    MP.emit('room:left');
    if (MP.UI) MP.UI.showHub();
    if (MP.Auth.user && code) MP.Auth.deleteLobby(code);
  };

  N.setReady = function (ready) { const s = requireSocket(); if (s) s.emit(EV.ROOM_SET_READY, { ready }); };
  N.setCampaign = function (campaign) { const s = requireSocket(); if (s) s.timeout(6000).emit(EV.ROOM_SET_CAMPAIGN, { campaign }, (e, r) => { if (r && !r.ok && MP.UI) MP.UI.sysToast(r.error); }); };
  N.startMatch = function () {
    const s = requireSocket(); if (!s) return;
    s.timeout(8000).emit(EV.ROOM_START, {}, (err, res) => {
      if (!err && res && !res.ok && MP.UI) MP.UI.sysToast(res.error || 'Cannot start yet.');
    });
  };
  N.listRooms = function (cb) {
    const s = requireSocket();
    if (!s) return cb({ ok: false, error: 'not connected', rooms: [] });
    s.timeout(6000).emit(EV.ROOM_LIST, {}, (err, res) => cb(err ? { ok: false, rooms: [], error: 'timeout' } : (res || { ok: false, rooms: [] })));
  };

  N._onRoomState = function (d) {
    if (!d || !d.room) return;
    const room = d.room;
    MP.members = room.members || [];
    MP.isHost = room.hostId === MP.playerId;
    MP.roomCode = room.code;
    MP.roomCodeSaved = room.code;
    MP.campaign = room.campaign;
    MP.inRoom = true;
    N.lastRoomCode = room.code;
    const me = MP.members.find(m => m.id === MP.playerId);
    MP.slot = me ? me.slot : 0;
    MP.emit('room:state', room);
    if (MP.UI) MP.UI.renderRoom(room);
    // lobby metadata mirror in Supabase (host only, best effort)
    if (MP.isHost && MP.Auth.user && room.phase === 'lobby') {
      MP.Auth.upsertLobby({
        code: room.code, host_id: MP.Auth.user.id, name: room.name || 'SIGNAL ROOM',
        campaign: room.campaign, player_count: room.members.filter(m => m.connected).length,
        max_players: 6, is_public: room.isPublic !== false, status: room.phase,
      });
    }
  };

  N._onRoomClosed = function (d) {
    const reason = d && d.reason;
    const wasInMatch = MP.active;
    MP.Game.leaveMatch(false);
    MP.inRoom = false; MP.roomCode = null;
    N.lastRoomCode = null;
    N.wantRoom = null;
    if (MP.isHost && MP.Auth.user && reason !== 'you_left') MP.Auth.deleteLobby(MP.roomCodeSaved || '');
    MP.roomCodeSaved = null;
    if (MP.UI) {
      if (reason === 'you_left') { /* handled by leaveRoom */ }
      else MP.UI.roomClosed(reason, wasInMatch);
    }
    MP.emit('room:closed', d);
  };

  /* ---------------- realtime senders ---------------- */

  /** called every frame by MP.Game.preFrame while in a match */
  N.tickMovement = function (dt) {
    const s = requireSocket();
    if (!s || !MP.active) return;
    N.moveAcc += dt;
    if (N.moveAcc < 1 / MOVE_HZ) return;
    N.moveAcc = 0;
    const pl = G.player;
    if (!pl) return;
    let f = 0;
    if (pl.crouching) f |= F.CROUCH;
    if (pl.sprinting) f |= F.SPRINT;
    if (pl.hidden) f |= F.HIDDEN;
    if (pl.dead || MP.Game.iAmDowned) f |= F.DOWNED;
    if (pl.flashlightOn && pl.hasFlashlight && pl.battery > 0 && !pl.hidden) f |= F.FLASH;
    if (pl.moveSpeedCur > 0.4 && !pl.hidden) f |= F.MOVING;
    const spot = pl.hidden && pl.hideSpot ? (WORLD.hideSpots.indexOf(pl.hideSpot)) : -1;
    s.emit(EV.STATE_MOVE, {
      p: [+pl.pos.x.toFixed(2), +(pl.camera.position.y || 0).toFixed(2), +pl.pos.z.toFixed(2)],
      yaw: +pl.yaw.toFixed(3), f, s: spot, t: Date.now(),
    });
  };

  N.sendGameEvent = function (ev, cb) {
    const s = requireSocket();
    if (!s) { cb && cb({ ok: false, error: 'offline' }); return; }
    s.timeout(6000).emit(EV.GAME_EVENT, ev, (err, res) => {
      cb && cb(err ? { ok: false, error: 'timeout' } : (res || { ok: false }));
    });
  };

  N.sendMonster = function (m) { const s = requireSocket(); if (s) s.emit(EV.SIM_MONSTER, m); };
  N.sendAnchors = function (a, cb) { const s = requireSocket(); if (!s) return cb && cb({ ok: false }); s.timeout(8000).emit(EV.WORLD_ANCHORS, a, (e, r) => cb && cb(e ? { ok: false } : r)); };
  N.sendInspect = function (p) { const s = requireSocket(); if (s) s.emit(EV.SIM_INSPECT, p); };
  N.sendSkillResult = function (ok) { const s = requireSocket(); if (s) s.emit(EV.GAME_SKILL_RESULT, { success: !!ok }); };
  N.sendDownRequest = function (target, reason, cb) { const s = requireSocket(); if (s) s.timeout(6000).emit(EV.GAME_DOWN_REQUEST, { target, reason }, (e, r) => cb && cb(e ? { ok: false } : r)); };
  N.sendReviveTick = function (target) { const s = requireSocket(); if (s) s.emit(EV.GAME_REVIVE_TICK, { target }); };
  N.sendRewindRequest = function () { const s = requireSocket(); if (s) s.emit(EV.GAME_REWIND_REQUEST, {}); };

  N.emitRaw = function (ev, data) { const s = requireSocket(); if (s) s.emit(ev, data); };
  N.pingServerInfo = async function () {
    try {
      const r = await fetch(MP.serverUrl + '/server-info', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      MP.serverInfo = await r.json();
      return MP.serverInfo;
    } catch (e) { return null; }
  };
})();
