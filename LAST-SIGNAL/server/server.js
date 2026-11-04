#!/usr/bin/env node
/* ============================================================
   THE LAST SIGNAL — authoritative multiplayer game server
   ------------------------------------------------------------
   Node.js + Express + Socket.IO.
   Serves BOTH the game client (static files from the project
   root) and the realtime gameplay API on one port, so a single
   Render Web Service runs the whole online game.

   Responsibilities:
     - validate Supabase access tokens on every connection
     - rooms (max 6), codes, membership, host migration
     - server-authoritative gameplay events (objectives, doors,
       pickups, chapters, endings, downs/revives) — see
       game-state.js for the validation rules
     - 15Hz batched player-state relay + monster relay
     - WebRTC voice signaling (media itself is peer-to-peer)
     - milestone persistence to Supabase (server-side secret)
   ============================================================ */
'use strict';

// ---- env ----
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { EV, PROTOCOL_VERSION, MAX_PLAYERS, ROOM_PHASE } = require('../shared/network-events');
const auth = require('./authentication');
const { RoomManager } = require('./rooms');
const { attachVoiceSignaling, notifyPeerLeft, hasTurn } = require('./voice-signaling');
const persistence = require('./persistence');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CLIENT_ORIGIN = process.env.CORS_ORIGIN || '*';
const PROJECT_ROOT = path.join(__dirname, '..');

const app = express();
app.disable('x-powered-by');

// ---- health / info ----
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'last-signal-server', protocol: PROTOCOL_VERSION, uptime: process.uptime() }));
app.get('/server-info', (_req, res) => res.json({
  ok: true,
  name: 'THE LAST SIGNAL — multiplayer server',
  protocol: PROTOCOL_VERSION,
  maxPlayersPerRoom: MAX_PLAYERS,
  auth: {
    supabaseUrl: auth.info.supabaseUrl,
    devGuestsAllowed: auth.info.devGuestsAllowed,
  },
  voice: { turnConfigured: hasTurn() },
  persistence: { serverSideSaves: persistence.enabled() },
  rooms: roomManager ? roomManager.rooms.size : 0,
}));

// ---- static client (the actual game) ----
app.use(express.static(PROJECT_ROOT, {
  extensions: ['html'],
  setHeaders: (res, p) => {
    if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, credentials: false },
  pingInterval: 12000,
  pingTimeout: 20000,
  maxHttpBufferSize: 64e3,           // gameplay packets are tiny; blocks abuse
});

const roomManager = new RoomManager(io, {
  log: (...a) => console.log(new Date().toISOString(), ...a),
  onLobbyEvent: (kind, room, token) => { roomManager.mirrorLobby(kind, room, token); },
  onMilestone: (kind, room, info) => { persistence.saveMilestone(kind, room, info).catch(e => console.warn('[persistence]', e.message)); },
});

/* ---------------- authentication middleware ---------------- */
io.use(async (socket, next) => {
  try {
    const player = await auth.authenticateHandshake(socket.handshake.auth || {});
    socket.data.playerId = player.id;
    socket.data.name = player.name;
    socket.data.token = player.token || null;
    socket.data.dev = !!player.dev;
    socket.data.authExp = player.exp;
    next();
  } catch (err) {
    console.warn('[auth] rejected socket:', err.message, '| from', socket.handshake.address);
    next(new Error(err.message || 'authentication failed'));
  }
});

/* ---------------- connection ---------------- */
io.on('connection', (socket) => {
  const playerId = socket.data.playerId;
  socket.join('player:' + playerId);
  console.log(`[net] ${socket.data.name} (${playerId.slice(0, 8)}) connected — ${socket.id} | ${io.engine.clientsCount} sockets online`);

  socket.emit(EV.NET_WELCOME, {
    playerId, name: socket.data.name, serverTime: Date.now(),
    protocol: PROTOCOL_VERSION, maxPlayers: MAX_PLAYERS,
    dev: !!socket.data.dev,
  });

  // re-associate with a room the player is still a member of (page refresh / network blip)
  const existing = roomManager.roomOf(playerId);
  if (existing) {
    const member = existing.members.get(playerId);
    if (member) {
      roomManager.attach(socket, existing, {});
      socket.emit(EV.ROOM_STATE, { room: existing.fullState(playerId) });
      if (existing.state.phase === ROOM_PHASE.PLAYING) {
        socket.emit(EV.GAME_SNAPSHOT, roomManager.joinSnapshot(existing, playerId));
        socket.emit(EV.SIM_ROLE, { isSimHost: existing.simHostId === playerId, reason: 'reconnect' });
      }
      console.log(`[net] ${playerId.slice(0, 8)} reconnected into room ${existing.code}`);
    }
  }

  /* ---- rooms ---- */
  socket.on(EV.ROOM_CREATE, (payload, ack) => safeAck(ack, () => roomManager.create(socket, payload || {})));
  socket.on(EV.ROOM_JOIN, (payload, ack) => safeAck(ack, () => {
    const res = roomManager.join(socket, payload || {});
    if (res.ok && res.snapshot) {
      const room = roomManager.roomOf(playerId);
      socket.emit(EV.SIM_ROLE, { isSimHost: room && room.simHostId === playerId, reason: 'join_in_progress' });
    }
    return res;
  }));
  socket.on(EV.ROOM_LEAVE, (_p, ack) => safeAck(ack, () => {
    socket.emit(EV.ROOM_CLOSED, { reason: 'you_left' });
    return roomManager.leave(socket, 'explicit');
  }));
  socket.on(EV.ROOM_LIST, (_p, ack) => safeAck(ack, () => ({ ok: true, rooms: roomManager.listRooms() })));
  socket.on(EV.ROOM_SET_READY, (payload, ack) => safeAck(ack, () => roomManager.setReady(socket, !!(payload && payload.ready))));
  socket.on(EV.ROOM_SET_CAMPAIGN, (payload, ack) => safeAck(ack, () => roomManager.setCampaign(socket, payload && payload.campaign)));
  socket.on(EV.ROOM_START, (_p, ack) => safeAck(ack, () => roomManager.start(socket)));

  /* ---- realtime gameplay ---- */
  socket.on(EV.STATE_MOVE, (mv) => { try { roomManager.onMove(socket, mv); } catch (e) { /* drop */ } });
  socket.on(EV.SIM_MONSTER, (m) => { try { roomManager.onMonster(socket, m); } catch (e) { /* drop */ } });
  socket.on(EV.GAME_EVENT, (ev, ack) => { try { roomManager.onGameEvent(socket, ev, ack); } catch (e) { safeAck(ack, () => ({ ok: false, error: String(e.message) })); } });
  socket.on(EV.WORLD_ANCHORS, (a, ack) => { try { roomManager.onAnchors(socket, a, ack); } catch (e) { safeAck(ack, () => ({ ok: false, error: String(e.message) })); } });

  /* ---- down / revive / wipe ---- */
  socket.on(EV.GAME_DOWN_REQUEST, (p, ack) => { try { roomManager.onDownRequest(socket, p || {}, ack); } catch (e) { safeAck(ack, () => ({ ok: false })); } });
  socket.on(EV.GAME_REVIVE_TICK, (p) => { try { roomManager.onReviveTick(socket, p || {}); } catch (e) { /* drop */ } });
  socket.on(EV.GAME_REWIND_REQUEST, () => { try { roomManager.onRewindRequest(socket); } catch (e) { /* drop */ } });

  /* ---- monster inspection relay + skill checks ---- */
  socket.on(EV.SIM_INSPECT, (p) => { try { roomManager.onSimInspect(socket, p || {}); } catch (e) { /* drop */ } });
  socket.on(EV.GAME_SKILL_RESULT, (p) => { try { roomManager.onSkillResult(socket, p || {}); } catch (e) { /* drop */ } });

  /* ---- voice signaling ---- */
  attachVoiceSignaling(socket, roomManager);

  /* ---- latency probe ---- */
  socket.on('net:ping2', (_p, ack) => { if (typeof ack === 'function') ack({ ok: true, t: Date.now() }); });

  /* ---- disconnect ---- */
  socket.on('disconnect', (reason) => {
    console.log(`[net] ${playerId.slice(0, 8)} disconnected (${reason})`);
    const room = roomManager.roomOf(playerId);
    roomManager.leave(socket, 'disconnect');
    if (room) notifyPeerLeft(roomManager, room, playerId);
  });

  socket.on('error', (err) => console.warn('[socket error]', playerId.slice(0, 8), err.message));
});

function safeAck(ack, fn) {
  if (typeof ack !== 'function') { try { fn(); } catch (e) { console.warn('[handler]', e.message); } return; }
  try { ack(fn()); } catch (e) {
    console.warn('[handler]', e.message);
    try { ack({ ok: false, error: e.message || 'internal error' }); } catch (_) { /* client gone */ }
  }
}

/* ---------------- process hardening ---------------- */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException — keeping server alive:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection — keeping server alive:', err);
});

server.listen(PORT, HOST, () => {
  console.log('=========================================================');
  console.log(' THE LAST SIGNAL — multiplayer game server');
  console.log(`  listening   : http://${HOST}:${PORT}`);
  console.log(`  protocol    : v${PROTOCOL_VERSION} · max ${MAX_PLAYERS} players/room`);
  console.log(`  supabase    : ${auth.info.supabaseUrl}`);
  console.log(`  dev guests  : ${auth.info.devGuestsAllowed ? 'ALLOWED (AUTH_MODE=dev)' : 'disabled (strict Supabase tokens)'}`);
  console.log(`  TURN relay  : ${hasTurn() ? 'configured' : 'not configured (STUN only)'}`);
  console.log(`  server saves: ${persistence.enabled() ? 'enabled (SUPABASE_SECRET_KEY set)' : 'disabled (clients save own rows via RLS)'}`);
  console.log(`  static client: ${PROJECT_ROOT}`);
  console.log('=========================================================');
});

module.exports = { server, io, app, roomManager };
