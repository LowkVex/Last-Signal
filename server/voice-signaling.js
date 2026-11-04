/* ============================================================
   THE LAST SIGNAL — game server: WebRTC voice signaling
   ------------------------------------------------------------
   The server NEVER touches audio. It only:
     - tells a joining client which peers are in its room channel
     - relays SDP offers/answers and ICE candidates between two
       sockets that are BOTH authenticated members of the SAME room
       (validated per message — no cross-room or stranger signaling)
     - hands out ICE server configuration at runtime so private
       TURN credentials live only in server environment variables
       and are never hardcoded into the client bundle
   Proximity attenuation is applied client-side (Web Audio gain +
   stereo pan driven by the server-synced player positions).
   ============================================================ */
'use strict';

const { EV } = require('../shared/network-events');

const DEFAULT_STUN = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',').map(s => s.trim()).filter(Boolean);

function buildIceServers() {
  const servers = DEFAULT_STUN.map(urls => ({ urls }));
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const urls = process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean);
    servers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

function hasTurn() {
  return !!(process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL);
}

/**
 * Wire voice signaling onto a socket.
 * @param {import('socket.io').Socket} socket
 * @param {RoomManager} rooms
 */
function attachVoiceSignaling(socket, rooms) {
  const roomOf = () => rooms.roomOf(socket.data.playerId);

  socket.on(EV.VOICE_HELLO, (payload, ack) => {
    const room = roomOf();
    if (!room) return ack && ack({ ok: false, error: 'not in a room' });
    const me = room.members.get(socket.data.playerId);
    if (!me) return ack && ack({ ok: false, error: 'not a member' });
    me.mic = ['on', 'off', 'muted'].includes(payload && payload.mic) ? payload.mic : 'on';
    me.voiceAt = Date.now();

    // tell me about every other connected member (I offer/answer with each)
    const peers = [...room.members.values()]
      .filter(m => m.playerId !== socket.data.playerId && m.connected)
      .map(m => ({ id: m.playerId, name: m.name, mic: m.mic || 'off' }));

    // tell them about me
    socket.to(room.ioRoom).emit(EV.VOICE_PEERS, {
      peers: [{ id: socket.data.playerId, name: me.name, mic: me.mic }],
    });
    if (room.state.phase === 'playing') room.pushState();
    ack && ack({ ok: true, peers, you: { id: socket.data.playerId, mic: me.mic }, iceServers: buildIceServers(), turn: hasTurn() });
  });

  socket.on(EV.VOICE_SIGNAL, ({ to, data } = {}) => {
    const room = roomOf();
    if (!room || !data) return;
    // BOTH endpoints must be members of the SAME room — validated here, every message
    const target = room.members.get(String(to || ''));
    if (!target || !target.connected) return;
    // payload hygiene: SDP/ICE only, size-capped
    let raw;
    try { raw = JSON.stringify(data); } catch (e) { return; }
    if (raw.length > 16384) return;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    rooms.toPlayer(String(to), EV.VOICE_SIGNAL, { from: socket.data.playerId, data });
  });

  socket.on(EV.VOICE_STATE, ({ mic } = {}) => {
    const room = roomOf();
    if (!room) return;
    const me = room.members.get(socket.data.playerId);
    if (!me) return;
    me.mic = ['on', 'off', 'muted'].includes(mic) ? mic : 'off';
    socket.to(room.ioRoom).emit(EV.VOICE_STATE, { id: socket.data.playerId, mic: me.mic });
    room.pushState();
  });

  socket.on(EV.VOICE_ICE_REQUEST, (_p, ack) => {
    ack && ack({ ok: true, iceServers: buildIceServers(), turn: hasTurn() });
  });
}

/** Notify the room that a voice peer is gone (called on disconnect/leave). */
function notifyPeerLeft(rooms, room, playerId) {
  if (!room) return;
  room.emit(EV.VOICE_PEER_LEFT, { id: playerId });
}

module.exports = { attachVoiceSignaling, buildIceServers, hasTurn, notifyPeerLeft };
