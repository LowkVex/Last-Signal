/* ============================================================
   THE LAST SIGNAL — game server: rooms & membership
   ------------------------------------------------------------
   - 5-char room codes, max 6 players per room (hard cap)
   - membership keyed by the *authenticated Supabase user id* —
     a client cannot claim to be somebody else
   - host + simulation-host roles, with automatic migration when
     the host disconnects
   - disconnect grace (45s) with safe reconnection & full-state
     resync; room cleanup when everybody is gone
   - 15Hz batched movement relay: clients send state:move, the
     server validates and re-broadcasts room snapshots — players
     never talk position peer-to-peer through the database
   ============================================================ */
'use strict';

const { EV, F, GE, MAX_PLAYERS, ROOM_PHASE, ERR, EMOTES } = require('../shared/network-events');
const { GameState } = require('./game-state');
const { sanitizeName } = require('./authentication');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/L/O/0/1 — codes get shouted in voice chat
const CODE_LEN = 5;
const DISCONNECT_GRACE_MS = 45000;
const SNAPSHOT_HZ = 15;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';

function makeCode(taken) {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < CODE_LEN; j++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(c)) return c;
  }
  return 'X' + Date.now().toString(36).toUpperCase().slice(-4);
}

class Room {
  constructor(manager, code, hostId, opts = {}) {
    this.manager = manager;
    this.code = code;
    this.hostId = hostId;
    this.simHostId = hostId;
    this.isPublic = opts.isPublic !== false;
    this.name = sanitizeName(opts.name) || 'SIGNAL ROOM';
    this.campaign = Math.min(8, Math.max(1, +opts.campaign || 1));
    this.members = new Map();     // playerId -> member
    this.joinOrder = [];          // playerIds, for host migration
    this.createdAt = Date.now();
    this.state = new GameState(this);
    this.ioRoom = 'room:' + code;
    this._snapshotTimer = null;
    this._dirty = false;
  }

  get phase() { return this.state.phase; }
  get connectedCount() { return [...this.members.values()].filter(m => m.connected).length; }
  get totalCount() { return this.members.size; }
  get full() { return this.connectedCount >= MAX_PLAYERS; }

  isHost(playerId) { return this.hostId === playerId; }
  isSimHost(playerId) { return this.simHostId === playerId && this.state.phase === ROOM_PHASE.PLAYING; }

  addMember(playerId, member) {
    this.members.set(playerId, member);
    if (!this.joinOrder.includes(playerId)) this.joinOrder.push(playerId);
  }

  removeMember(playerId) {
    this.members.delete(playerId);
    this.joinOrder = this.joinOrder.filter(id => id !== playerId);
    if (this.hostId === playerId) this.migrateHost();
    if (this.simHostId === playerId) this.migrateSimHost('host_left');
  }

  migrateHost() {
    const next = this.joinOrder.find(id => this.members.get(id) && this.members.get(id).connected)
      || this.joinOrder.find(id => this.members.get(id));
    this.hostId = next || null;
    if (next) this.manager.log(`room ${this.code}: host migrated to ${next.slice(0, 8)}`);
  }

  migrateSimHost(reason) {
    if (this.state.phase !== ROOM_PHASE.PLAYING) return;
    const next = this.joinOrder.find(id => {
      const m = this.members.get(id);
      return m && m.connected && !m.downed;
    }) || this.joinOrder.find(id => { const m = this.members.get(id); return m && m.connected; });
    this.simHostId = next || null;
    if (next) {
      this.manager.toPlayer(next, EV.SIM_ROLE, { isSimHost: true, reason: reason || 'migration', monster: this.state.monster });
      this.manager.log(`room ${this.code}: sim host migrated to ${next.slice(0, 8)} (${reason})`);
    }
  }

  emit(event, payload) { this.manager.io.to(this.ioRoom).emit(event, payload); }
  broadcastApplied(applied) {
    if (!applied) return;
    const list = Array.isArray(applied) ? applied : [applied];
    for (const a of list) {
      this.state.seq++;
      this.emit(EV.GAME_APPLIED, { ...a, by: a.by || null, seq: this.state.seq });
    }
  }

  publicInfo() {
    return {
      code: this.code, name: this.name, hostId: this.hostId, campaign: this.campaign,
      phase: this.phase, isPublic: this.isPublic,
      players: this.connectedCount, maxPlayers: MAX_PLAYERS,
    };
  }

  fullState(forPlayerId) {
    const members = [...this.members.values()].map(m => ({
      id: m.playerId, name: m.name, ready: !!m.ready, isHost: m.playerId === this.hostId,
      connected: m.connected, downed: !!m.downed, mic: m.mic || 'off', slot: m.slot ?? -1,
      you: m.playerId === forPlayerId,
    }));
    return {
      code: this.code, name: this.name, campaign: this.campaign, phase: this.phase,
      hostId: this.hostId, simHostId: this.simHostId, maxPlayers: MAX_PLAYERS, members,
      isPublic: this.isPublic,
    };
  }

  pushState() { this.emit(EV.ROOM_STATE, { room: this.fullState(null) }); }

  startSnapshots() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setInterval(() => this.sendSnapshot(), 1000 / SNAPSHOT_HZ);
    if (this._snapshotTimer.unref) this._snapshotTimer.unref();
  }

  stopSnapshots() {
    clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
  }

  sendSnapshot() {
    if (this.state.phase !== ROOM_PHASE.PLAYING) return;
    const p = [];
    for (const m of this.members.values()) {
      if (!m.pos) continue;
      let f = 0;
      if (m.crouch) f |= F.CROUCH;
      if (m.sprint) f |= F.SPRINT;
      if (m.hidden) f |= F.HIDDEN;
      if (m.downed) f |= F.DOWNED;
      if (m.flash) f |= F.FLASH;
      if (m.moving) f |= F.MOVING;
      if ((m.mic || 'off') === 'on') f |= F.MIC;
      if ((m.mic || 'off') === 'muted') f |= F.MUTED;
      p.push([m.playerId, +m.pos[0].toFixed(2), +m.pos[1].toFixed(2), +m.pos[2].toFixed(2),
        +(m.yaw || 0).toFixed(3), f, m.spot === undefined ? -1 : m.spot]);
    }
    if (p.length) this.emit(EV.STATE_PLAYERS, { t: Date.now(), p });
  }

  destroy() {
    this.stopSnapshots();
    this.state.destroy();
  }
}

class RoomManager {
  constructor(io, opts = {}) {
    this.io = io;
    this.rooms = new Map();          // code -> Room
    this.playerRoom = new Map();     // playerId -> code
    this.socketPlayer = new Map();   // socket.id -> {playerId, name, token}
    this.log = opts.log || ((...a) => console.log('[rooms]', ...a));
    this.onLobbyEvent = opts.onLobbyEvent || (() => {});   // supabase lobby mirror hook
    this.onMilestone = opts.onMilestone || (() => {});     // persistence hook (chapter/ending)
    this._cleanupTimer = setInterval(() => this.cleanup(), 15000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  toPlayer(playerId, event, payload) {
    this.io.to('player:' + playerId).emit(event, payload);
  }

  roomOf(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  /* ---------------- create / join / leave ---------------- */

  create(socket, { isPublic = true, campaign = 1, name = '' } = {}) {
    const { playerId } = socket.data;
    if (this.playerRoom.has(playerId)) {
      const r = this.roomOf(playerId);
      if (r) return { ok: false, error: 'You are already in a room. Leave it first.', code: ERR.ALREADY_IN_ROOM };
      this.playerRoom.delete(playerId);
    }
    const code = makeCode(new Set(this.rooms.keys()));
    const room = new Room(this, code, playerId, { isPublic, campaign, name });
    this.rooms.set(code, room);
    this.attach(socket, room, { ready: true });
    room.pushState();
    this.onLobbyEvent('created', room, socket.data.token);
    this.log(`room ${code} created by ${playerId.slice(0, 8)} (campaign ${room.campaign})`);
    return { ok: true, code, room: room.fullState(playerId) };
  }

  join(socket, { code } = {}) {
    const { playerId } = socket.data;
    code = String(code || '').trim().toUpperCase();
    if (!code) return { ok: false, error: 'Enter a room code.', code: ERR.BAD_REQUEST };
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: `No room found with code ${code}. Check the code and try again.`, code: ERR.ROOM_NOT_FOUND };

    const existing = this.playerRoom.get(playerId);
    if (existing && existing !== code) {
      return { ok: false, error: 'You are already in another room. Leave it first.', code: ERR.ALREADY_IN_ROOM };
    }
    const member = room.members.get(playerId);
    if (!member) {
      if (room.full) return { ok: false, error: 'That room is full (6 players maximum).', code: ERR.ROOM_FULL };
    }
    const resync = this.attach(socket, room, {});
    if (room.state.phase === ROOM_PHASE.PLAYING) room.pushState();
    this.onLobbyEvent('joined', room, socket.data.token);
    return { ok: true, code: room.code, room: room.fullState(playerId), snapshot: room.state.phase === ROOM_PHASE.PLAYING ? this.joinSnapshot(room, playerId) : null, resync };
  }

  /** Everything a joining/reconnecting client needs to catch up mid-match. */
  joinSnapshot(room, playerId) {
    const member = room.members.get(playerId);
    return {
      state: room.state.snapshot(),
      slots: this.slotMap(room),
      spawn: this.spawnFor(room, playerId),
      simHostId: room.simHostId,
      hostId: room.hostId,
      members: room.fullState(playerId).members,
      slot: member ? member.slot : -1,
      downed: [...room.members.values()].filter(m => m.downed).map(m => m.playerId),
    };
  }

  slotMap(room) {
    const m = {};
    for (const mem of room.members.values()) if (mem.slot !== undefined && mem.slot !== null) m[mem.playerId] = mem.slot;
    return m;
  }

  spawnFor(room, playerId) {
    const mem = room.members.get(playerId);
    const slot = mem && mem.slot !== undefined ? mem.slot : 0;
    const cp = room.state.checkpoint;
    return { slot, gx: cp ? cp.gx : null, gy: cp ? cp.gy : null, yaw: cp ? cp.yaw || 0 : 0 };
  }

  /** Attach socket to room; returns true when this was a reconnection restore. */
  attach(socket, room, extra) {
    const { playerId, name, token } = socket.data;
    let member = room.members.get(playerId);
    let resync = false;
    if (!member) {
      // assign the lowest free slot 0..5
      const used = new Set([...room.members.values()].map(m => m.slot));
      let slot = 0; while (used.has(slot) && slot < MAX_PLAYERS - 1) slot++;
      member = {
        playerId, name: sanitizeName(name) || 'SIGNAL', token,
        socketId: socket.id, connected: true, ready: false, slot,
        pos: null, yaw: 0, crouch: false, sprint: false, hidden: false, flash: false, moving: false, spot: -1,
        downed: false, mic: 'off', joinedAt: Date.now(), lastSeen: Date.now(),
        ...extra,
      };
      room.addMember(playerId, member);
    } else {
      resync = !member.connected || member.socketId !== socket.id;
      member.socketId = socket.id;
      member.connected = true;
      member.token = token;
      member.name = sanitizeName(name) || member.name;
      member.lastSeen = Date.now();
      clearTimeout(member._graceTimer);
      member._graceTimer = null;
      // returning from a disconnect: they come back standing (their "down" was the disconnect itself)
      if (member.downed && member.downReason === 'disconnect') {
        member.downed = false;
        member.downReason = null;
        room.state.allowTeleport(playerId);
        room.state.wiped = false;
      }
      Object.assign(member, extra);
    }
    this.playerRoom.set(playerId, room.code);
    socket.join(room.ioRoom);
    socket.join('player:' + playerId);
    socket.data.roomCode = room.code;
    room.pushState();
    // join/reconnect notification for the room's chat feed (mid-match only —
    // every entry path goes through attach(): create, join, and auto-reconnect)
    if (room.state.phase === ROOM_PHASE.PLAYING) {
      room.emit(EV.CHAT_MSG, { sys: true, text: `${member.name} ${resync ? 'reconnected to' : 'joined'} the expedition.`, ts: Date.now() });
    }
    return resync;
  }

  leave(socket, reason) {
    const { playerId } = socket.data;
    const room = this.roomOf(playerId);
    if (!room) return { ok: true };
    const member = room.members.get(playerId);
    socket.leave(room.ioRoom);
    this.playerRoom.delete(playerId);
    socket.data.roomCode = null;
    if (!member) return { ok: true };

    if (reason === 'explicit' || room.state.phase !== ROOM_PHASE.PLAYING) {
      // hard remove
      room.removeMember(playerId);
      room.emit(EV.GAME_APPLIED, { type: 'player_left', player: playerId, seq: ++room.state.seq });
      room.pushState();
      this.onLobbyEvent('left', room, member.token);
      if (room.totalCount === 0) this.destroyRoom(room, 'empty');
      else if (room.state.phase === ROOM_PHASE.PLAYING) room.state.checkWipe();
    } else {
      // disconnect during a match: grace period, teammates can keep playing / revive
      member.connected = false;
      member.downed = true;             // a disconnected player is vulnerable & revivable on return
      member.downReason = 'disconnect';
      this.playerRoom.set(playerId, room.code);   // KEEP the mapping: roomOf() must find the room on reconnect
      member._graceTimer = setTimeout(() => {
        const still = room.members.get(playerId);
        if (still && !still.connected) {
          this.playerRoom.delete(playerId);
          room.removeMember(playerId);
          room.emit(EV.GAME_APPLIED, { type: 'player_left', player: playerId, seq: ++room.state.seq });
          room.pushState();
          this.onLobbyEvent('left', room, member.token);
          if (room.totalCount === 0) this.destroyRoom(room, 'empty');
          else room.state.checkWipe();
        }
      }, DISCONNECT_GRACE_MS);
      room.pushState();
      room.state.checkWipe();
    }
    return { ok: true };
  }

  destroyRoom(room, reason) {
    room.destroy();
    this.rooms.delete(room.code);
    for (const [pid, code] of this.playerRoom) if (code === room.code) this.playerRoom.delete(pid);
    room.emit(EV.ROOM_CLOSED, { reason: reason || 'closed' });
    this.onLobbyEvent('closed', room, null);
    this.log(`room ${room.code} destroyed (${reason})`);
  }

  cleanup() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.totalCount === 0) { this.destroyRoom(room, 'empty'); continue; }
      // lobby rooms idle for > 10 minutes with nobody connected
      if (room.connectedCount === 0 && now - room.createdAt > 10 * 60e3) this.destroyRoom(room, 'stale');
    }
  }

  /* ---------------- room actions ---------------- */

  setReady(socket, ready) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (room.state.phase === ROOM_PHASE.PLAYING) return { ok: false, error: 'Match already running.' };
    const m = room.members.get(socket.data.playerId);
    m.ready = !!ready;
    room.pushState();
    return { ok: true };
  }

  setCampaign(socket, campaign) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (!room.isHost(socket.data.playerId)) return { ok: false, error: 'Only the host can change the chapter.', code: ERR.NOT_HOST };
    if (room.state.phase === ROOM_PHASE.PLAYING) return { ok: false, error: 'Cannot change chapter mid-match.', code: ERR.IN_GAME };
    campaign = Math.min(8, Math.max(1, +campaign || 1));
    room.campaign = campaign;
    room.state.reset(campaign);
    room.pushState();
    this.onLobbyEvent('updated', room, socket.data.token);
    return { ok: true };
  }

  start(socket) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (!room.isHost(socket.data.playerId)) return { ok: false, error: 'Only the host can start the descent.', code: ERR.NOT_HOST };
    if (room.state.phase === ROOM_PHASE.PLAYING) return { ok: false, error: 'Already running.' };
    const members = [...room.members.values()].filter(m => m.connected);
    if (members.length < 1) return { ok: false, error: 'No players.' };
    const notReady = members.filter(m => !m.ready && m.playerId !== room.hostId);
    if (notReady.length) return { ok: false, error: `Waiting for: ${notReady.map(m => m.name).join(', ')}`, code: ERR.NOT_READY };

    // commit the match
    room.state.reset(room.campaign);
    room.state.phase = ROOM_PHASE.PLAYING;
    room.state.startedAt = Date.now();
    room.simHostId = room.hostId;
    for (const m of members) m.downed = false;
    room.startSnapshots();

    const slots = this.slotMap(room);
    room.emit(EV.GAME_START, {
      campaign: room.campaign, slots, simHostId: room.simHostId, hostId: room.hostId,
      spawnBase: null, ts: Date.now(),
      members: members.map(m => ({ id: m.playerId, name: m.name, slot: m.slot })),
    });
    for (const m of members) {
      this.toPlayer(m.playerId, EV.SIM_ROLE, { isSimHost: m.playerId === room.simHostId, reason: 'match_start' });
    }
    room.pushState();
    this.onLobbyEvent('started', room, socket.data.token);
    this.log(`room ${room.code}: match started (campaign ${room.campaign}, ${members.length} players)`);
    return { ok: true };
  }

  listRooms() {
    return [...this.rooms.values()]
      .filter(r => r.isPublic || r.connectedCount > 0)
      .map(r => r.publicInfo());
  }

  /* ---------------- realtime handlers (called from server.js) ---------------- */

  onMove(socket, mv) {
    const room = this.roomOf(socket.data.playerId);
    if (!room || room.state.phase !== ROOM_PHASE.PLAYING || !mv || !Array.isArray(mv.p)) return;
    const member = room.members.get(socket.data.playerId);
    if (!member || member.downed) {
      // downed players keep broadcasting their corpse position but cannot move
      if (member && member.pos && Array.isArray(mv.p)) { /* ignore movement, keep last pos */ }
      return;
    }
    const [x, y, z] = [+mv.p[0], +mv.p[1], +mv.p[2]];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    const bounds = room.state.anchors && room.state.anchors.bounds;
    if (bounds && (x < bounds.minX - 4 || x > bounds.maxX + 4 || z < bounds.minZ - 4 || z > bounds.maxZ + 4)) return;
    const ok = room.state.setPlayerPos(socket.data.playerId, x, y, z);
    if (!ok) return;   // impossible speed — sample dropped (anti-teleport)
    member.yaw = isFinite(+mv.yaw) ? +mv.yaw : member.yaw;
    const f = +mv.f | 0;
    member.crouch = !!(f & F.CROUCH);
    member.sprint = !!(f & F.SPRINT);
    member.hidden = !!(f & F.HIDDEN);
    member.flash = !!(f & F.FLASH);
    member.moving = !!(f & F.MOVING);
    member.spot = mv.s === undefined ? -1 : (mv.s | 0);
    member.lastSeen = Date.now();
  }

  onMonster(socket, m) {
    const room = this.roomOf(socket.data.playerId);
    if (!room || room.state.phase !== ROOM_PHASE.PLAYING) return;
    if (room.state.acceptMonster(socket.data.playerId, m)) {
      socket.to(room.ioRoom).emit(EV.STATE_MONSTER, { ...room.state.monster });
    }
  }

  onGameEvent(socket, ev, ack) {
    const room = this.roomOf(socket.data.playerId);
    const respond = (r) => { if (typeof ack === 'function') ack(r); };
    if (!room) return respond({ ok: false, error: 'Not in a room.' });
    const playerId = socket.data.playerId;

    // events only the SIMULATION HOST may send
    if (ev && ev.type === 'sim') {
      if (!room.isSimHost(playerId)) return respond({ ok: false, error: 'not sim host' });
      return respond({ ok: true });
    }

    const res = room.state.handleEvent(playerId, ev || {});
    if (!res.ok) return respond({ ok: false, error: res.error || 'rejected' });
    respond({ ok: true });
    if (res.applied) {
      const list = Array.isArray(res.applied) ? res.applied : [res.applied];
      for (const a of list) a.by = playerId;
      room.broadcastApplied(list);
      this.afterApplied(room, playerId, list);
    }
  }

  /** Server-side side effects after an event is applied (milestones, timers...). */
  afterApplied(room, playerId, list) {
    for (const a of list) {
      if (a.type === GE.ENDING || a.type === GE.CHAPTER_COMPLETE) {
        this.onMilestone('ending', room, { ending: a.id || 'complete', campaign: room.campaign });
        room.pushState();   // phase changed to 'ended' — clients need the fresh room state
      }
    }
  }

  onAnchors(socket, anchors, ack) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const res = room.state.setAnchors(socket.data.playerId, anchors);
    ack && ack(res);
    if (res.ok) this.log(`room ${room.code}: anchors registered (${anchors.doors ? anchors.doors.length : 0} doors, ${anchors.pickups ? anchors.pickups.length : 0} pickups)`);
  }

  onDownRequest(socket, { target, reason } = {}, ack) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return ack && ack({ ok: false });
    const playerId = socket.data.playerId;
    // only the sim host may report kills, or the victim reporting its own local death chain
    const isSim = room.isSimHost(playerId);
    const isSelf = target === playerId;
    if (!isSim && !isSelf) return ack && ack({ ok: false, error: 'not authorized' });
    const res = room.state.requestDown(playerId, target || playerId, reason);
    ack && ack({ ok: res.ok, error: res.error });
    if (res.ok && res.applied) {
      room.emit(EV.GAME_PLAYER_DOWNED, { player: res.applied.player, reason: res.applied.reason });
      room.pushState();
      this.onMilestone('down', room, { player: res.applied.player, reason: res.applied.reason });
    }
  }

  onReviveTick(socket, { target } = {}) {
    const room = this.roomOf(socket.data.playerId);
    if (!room || room.state.phase !== ROOM_PHASE.PLAYING) return;
    const res = room.state.reviveTick(socket.data.playerId, target);
    if (!res.ok || !res.applied) return;
    if (res.done) {
      room.emit(EV.GAME_PLAYER_REVIVED, { player: res.applied.player, at: res.applied.at });
      room.pushState();
    } else {
      this.toPlayer(target, EV.GAME_REVIVE_PROGRESS, res.applied);
      this.toPlayer(socket.data.playerId, EV.GAME_REVIVE_PROGRESS, res.applied);
    }
  }

  onRewindRequest(socket) {
    const room = this.roomOf(socket.data.playerId);
    if (!room || !room.state.wiped) return;
    const applied = room.state.rewind();
    room.broadcastApplied(applied);
    room.pushState();
  }

  onSimInspect(socket, payload) {
    const room = this.roomOf(socket.data.playerId);
    if (!room || !room.isSimHost(socket.data.playerId)) return;
    const target = payload && payload.target;
    if (!target || !room.members.has(target)) return;
    this.toPlayer(target, EV.GAME_INSPECT, { ...payload, from: socket.data.playerId });
  }

  onSkillResult(socket, { success } = {}) {
    const room = this.roomOf(socket.data.playerId);
    if (!room) return;
    // relay to the sim host — the sim host's monster AI consumes the result
    this.toPlayer(room.simHostId, EV.SIM_SKILL_RESULT, { by: socket.data.playerId, success: !!success });
  }

  /* ---------------- text chat + emotes (room-scoped, validated) ---------------- */

  onChat(socket, payload, ack) {
    const respond = (r) => { if (typeof ack === 'function') ack(r); };
    const room = this.roomOf(socket.data.playerId);
    const member = room && room.members.get(socket.data.playerId);
    if (!member) return respond({ ok: false, error: 'not in a room', code: ERR.ROOM_NOT_FOUND });

    let text = payload && typeof payload.text === 'string' ? payload.text : '';
    // strip control chars, collapse whitespace, hard length cap (clients render
    // with textContent, but the transcript is also stored in DOM/log-able)
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return respond({ ok: false, error: 'empty message', code: ERR.BAD_REQUEST });

    // spam protection: sliding window — max 6 messages per 10s per member
    const now = Date.now();
    member._chatTimes = (member._chatTimes || []).filter((t) => now - t < 10000);
    if (member._chatTimes.length >= 6) {
      return respond({ ok: false, error: 'Too many messages — slow down.', code: ERR.RATE_LIMITED });
    }
    member._chatTimes.push(now);

    // "/wave" & friends are emotes, not chat lines
    const cmd = /^\/([a-z]+)$/i.exec(text);
    if (cmd) {
      const emote = cmd[1].toLowerCase();
      if (!EMOTES.includes(emote)) {
        return respond({ ok: false, error: `Unknown emote. Try: ${EMOTES.map((x) => '/' + x).join('  ')}`, code: ERR.BAD_REQUEST });
      }
      room.emit(EV.EMOTE, { player: member.playerId, emote, ts: now });
      return respond({ ok: true, emote });
    }

    // identity is the SERVER's record — a client can never chat under another name
    room.emit(EV.CHAT_MSG, { from: member.playerId, name: member.name, text, ts: now });
    respond({ ok: true });
  }

  /* ---------------- supabase lobby mirror (best effort) ---------------- */

  async mirrorLobby(kind, room, userToken) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !userToken) return;
    try {
      const headers = {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      };
      if (kind === 'created' || kind === 'updated' || kind === 'started' || kind === 'joined' || kind === 'left') {
        const row = {
          code: room.code, host_id: room.hostId, name: room.name, campaign: room.campaign,
          player_count: room.connectedCount, max_players: MAX_PLAYERS,
          is_public: room.isPublic, status: room.state.phase,
        };
        await fetch(`${SUPABASE_URL}/rest/v1/lobbies?code=eq.${encodeURIComponent(room.code)}`, {
          method: 'POST', headers: { ...headers, Prefer: 'return=minimal,resolution=merge-duplicates' },
          body: JSON.stringify(row),
        });
      } else if (kind === 'closed') {
        await fetch(`${SUPABASE_URL}/rest/v1/lobbies?code=eq.${encodeURIComponent(room.code)}`, { method: 'DELETE', headers });
      }
    } catch (e) {
      // best effort only — the live room list from the server is authoritative
    }
  }
}

module.exports = { RoomManager, Room, makeCode, DISCONNECT_GRACE_MS, CODE_LEN };
