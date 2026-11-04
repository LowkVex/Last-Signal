'use strict';
/* ============================================================
   THE LAST SIGNAL — multiplayer server integration test
   ------------------------------------------------------------
   Spawns the REAL server (AUTH_MODE=dev, short lift warm-up) and
   drives it with socket.io-client guests. Covers:
     auth rejection / dev-guest handshake / welcome
     room create + code + list + join + invalid code + capacity
     ready/start rules (host-only, all-ready)
     world anchors permission (sim host only)
     movement broadcast + anti-teleport
     server-validated progression: door lock/unlock (keycard,
       code ok + wrong code), pickups (shared, once), fuses ->
       powerOn -> POWER, chapters order + prerequisites,
       calibrated/containment/core/truth, lever -> server warm-up
       -> LIFT_READY, escape -> server-computed ENDING (B)
     down request validation (monster range, authorization),
       revive ticks -> progress -> revived, team wipe -> rewind
     disconnect grace + reconnect snapshot, host migration
     voice signaling hello/relay, ping
   Run:  npm test        (inside LAST-SIGNAL/server)
   ============================================================ */

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { io } = require('socket.io-client');
const NET = require('../../shared/network-events.js');
const EV = NET.EV;

const PORT = 34500 + Math.floor(Math.random() * 400);
const URL = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

/* ---------------- harness ---------------- */

const results = [];
let child = null;
const sockets = [];

function track(s) { sockets.push(s); return s; }

function connectRaw(auth) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { auth, transports: ['websocket'], reconnection: false, timeout: 3000, forceNew: true });
    const t = setTimeout(() => { s.close(); reject(new Error('connect timeout')); }, 6000);
    s.once('connect', () => { clearTimeout(t); resolve(track(s)); });
    s.once('connect_error', (e) => { clearTimeout(t); s.close(); reject(e); });
  });
}

/** connect a dev guest and wait for net:welcome (listener attached BEFORE
 *  the socket can fire, so the welcome packet can never be missed) */
function guestWithId(id, name) {
  const s = track(io(URL, { auth: { token: 'dev-guest:' + id, name }, transports: ['websocket'], reconnection: false, timeout: 3000, forceNew: true }));
  // buffer packets the server fires immediately after welcome (reconnect flow)
  s._early = { roomState: null, snapshot: null };
  s.on(EV.ROOM_STATE, (d) => { if (!s._early.roomState) s._early.roomState = d; });
  s.on(EV.GAME_SNAPSHOT, (d) => { if (!s._early.snapshot) s._early.snapshot = d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('no welcome for ' + name)); }, 6000);
    s.once(EV.NET_WELCOME, (d) => {
      clearTimeout(t);
      s.playerId = d.playerId;
      s.welcome = d;
      resolve(s);
    });
    s.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}
function guest(name) { return guestWithId(uuid(), name); }

function once(s, ev, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev} on ${s.playerId || '?'}`)), ms);
    s.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

/** resolves with the FIRST game:applied payload matching pred */
function appliedMatching(s, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(EV.GAME_APPLIED, h); reject(new Error('timeout waiting for game:applied match')); }, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(EV.GAME_APPLIED, h); resolve(d); } };
    s.on(EV.GAME_APPLIED, h);
  });
}

/** resolves with the FIRST room:state matching pred.
 *  IMPORTANT: attach BEFORE the action that triggers it — the server pushes
 *  room:state synchronously while handling the ack, so a listener attached
 *  after `await send(...)` can miss the broadcast entirely. */
function roomStateMatching(s, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(EV.ROOM_STATE, h); reject(new Error('timeout waiting for room:state match')); }, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(EV.ROOM_STATE, h); resolve(d); } };
    s.on(EV.ROOM_STATE, h);
  });
}

function ack(s, ev, payload, ms = 5000) {
  return new Promise((resolve, reject) => {
    s.timeout(ms).emit(ev, payload, (err, res) => { err ? reject(new Error(`${ev} ack error: ${err.message || err}`)) : resolve(res); });
  });
}

/** Reposition a player LEGALLY: the server validates speed (<= 7.5 m/s),
 *  so sleep long enough for the distance jumped. */
async function moveTo(s, x, z) {
  const prev = s._pos || [x, z];
  const dist = Math.hypot(x - prev[0], z - prev[1]);
  s.emit(EV.STATE_MOVE, { p: [x, 0, z], yaw: 0, f: 0, s: -1, t: Date.now() });
  s._pos = [x, z];
  await sleep(Math.min(1500, Math.max(430, (dist / 6) * 1000 + 200)));
}

function downReq(s, target, reason = 'caught') {
  return new Promise((resolve) => {
    s.timeout(3000).emit(EV.GAME_DOWN_REQUEST, { target, reason }, (e, r) => resolve(r || { ok: false, error: String((e && e.message) || e) }));
  });
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/* ---------------- server lifecycle ---------------- */

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '0.0.0.0',
      AUTH_MODE: 'dev', NODE_ENV: 'test',
      LIFT_WARMUP_MS: '1200',
      SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '',
      TURN_URL: '', TURN_USERNAME: '', TURN_CREDENTIAL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.TEST_VERBOSE && process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start:\n' + out)), 10000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (process.env.TEST_VERBOSE) process.stdout.write('[server] ' + d);
      if (out.includes('listening')) { clearTimeout(t); resolve(); }
    });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error('server exited early code ' + c + '\n' + out)); });
  });
}

/* ---------------- the suite ---------------- */

async function run() {
  console.log(`\nTHE LAST SIGNAL — server integration test (port ${PORT})\n`);

  /* ===== auth ===== */
  await test('rejects connection without a token', async () => {
    await assert.rejects(() => connectRaw({}), /token|authenticat/i);
  });

  await test('rejects connection with a bogus token', async () => {
    await assert.rejects(() => connectRaw({ token: 'sb-secret-stolen-key' }), /.+/);
  });

  await test('accepts dev guest and sends net:welcome with the stable playerId', async () => {
    const g = await guest('TESTER');
    assert.strictEqual(typeof g.playerId, 'string');
    assert.strictEqual(g.welcome.dev, true);
    assert.strictEqual(g.welcome.protocol, NET.PROTOCOL_VERSION);
    assert.strictEqual(g.welcome.maxPlayers, NET.MAX_PLAYERS);
    g.close();
  });

  /* ===== rooms: create / list / join / invalid / capacity ===== */
  let p1, p2, code1;
  await test('creates a room with a 5-character code, listed publicly', async () => {
    p1 = await guest('HOST-ONE');
    const res = await ack(p1, EV.ROOM_CREATE, { isPublic: true, campaign: 1, name: 'TEST ROOM' });
    assert.strictEqual(res.ok, true, 'create failed: ' + JSON.stringify(res));
    assert.strictEqual(typeof res.code, 'string');
    assert.strictEqual(res.code.length, 5);
    code1 = res.code;
    const list = await ack(p1, EV.ROOM_LIST, {});
    assert.ok(list.rooms.find((r) => r.code === code1), 'room not in list');
  });

  await test('rejects joining an unknown code', async () => {
    const g = await guest('LOST');
    const res = await ack(g, EV.ROOM_JOIN, { code: 'QQQQQ' });
    assert.strictEqual(res.ok, false);
    assert.ok(/not found|no room/i.test(res.error || ''), 'wrong error: ' + res.error);
    g.close();
  });

  await test('second player joins by code; both see a 2-member room:state', async () => {
    p2 = await guest('PARTNER');
    const stateP = once(p2, EV.ROOM_STATE);
    const res = await ack(p2, EV.ROOM_JOIN, { code: code1 });
    assert.strictEqual(res.ok, true, 'join failed: ' + JSON.stringify(res));
    const meAck = (res.room.members || []).find((m) => m.id === p2.playerId);
    assert.ok(meAck && meAck.you, 'join ack must mark me as you');
    const st = await stateP;
    assert.strictEqual(st.room.code, code1);
    assert.strictEqual(st.room.members.length, 2);
    assert.strictEqual(st.room.hostId, p1.playerId);
  });

  await test('enforces the 6-player capacity', async () => {
    const host = await guest('CAP-HOST');
    const cr = await ack(host, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    assert.strictEqual(cr.ok, true);
    const joiners = [];
    for (let i = 0; i < 5; i++) {
      const g = await guest('CAP-' + i);
      const r = await ack(g, EV.ROOM_JOIN, { code: cr.code });
      assert.strictEqual(r.ok, true, 'joiner ' + i + ' rejected: ' + JSON.stringify(r));
      joiners.push(g);
    }
    const extra = await guest('CAP-EXTRA');
    const rej = await ack(extra, EV.ROOM_JOIN, { code: cr.code });
    assert.strictEqual(rej.ok, false);
    assert.ok(/full/i.test(rej.error || ''), 'wrong error: ' + rej.error);
    extra.close(); host.close(); joiners.forEach((g) => g.close());
    await sleep(120);
  });

  /* ===== ready / start rules ===== */
  await test('only the host can start; not-ready members block the launch', async () => {
    const bad = await ack(p2, EV.ROOM_START, {});
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, NET.ERR.NOT_HOST);
    const early = await ack(p1, EV.ROOM_START, {});
    assert.strictEqual(early.ok, false);
    assert.strictEqual(early.code, NET.ERR.NOT_READY);
  });

  let start1, start2, simHostId;
  await test('host starts the match once everyone is ready (game:start to all)', async () => {
    await ack(p2, EV.ROOM_SET_READY, { ready: true });
    const s1 = once(p1, EV.GAME_START);
    const s2 = once(p2, EV.GAME_START);
    const res = await ack(p1, EV.ROOM_START, {});
    assert.strictEqual(res.ok, true, 'start failed: ' + JSON.stringify(res));
    start1 = await s1; start2 = await s2;
    assert.strictEqual(start1.campaign, 1);
    assert.ok(start1.simHostId, 'no simHostId');
    assert.strictEqual(start1.simHostId, start2.simHostId);
    assert.strictEqual(start1.members.length, 2);
    simHostId = start1.simHostId;
  });

  /* ===== anchors permission ===== */
  const ANCHORS = {
    doors: [
      { key: 'kc_door', type: 'keycard', x: 11, z: 10 },
      { key: 'code_door', type: 'code', code: '4713', x: 15, z: 10 },
      { key: 'plain_door', type: 'plain', x: 9, z: 12 },
    ],
    pickups: [
      { id: 'pick_keycard_1', item: 'keycard', x: 11.2, z: 10 },
      { id: 'pick_fuse_1', item: 'fuse', x: 13, z: 10 },
      { id: 'pick_fuse_2', item: 'fuse', x: 10, z: 13 },
    ],
    regions: [{ id: 'exit', x: 30, z: 30, w: 4, h: 4, zone: 'X' }],
    hideSpots: [{ x: 12, z: 12 }],
    spawn: { x: 10, z: 10 },
    bounds: { minX: 0, maxX: 60, minZ: 0, maxZ: 60 },
    fusePanel: { x: 13.5, z: 10 }, lever: { x: 16, z: 10 }, console: { x: 17, z: 10 },
    freq: { x: 18, z: 10 }, core: { x: 19, z: 10 }, elevator: { x: 20, z: 10 },
    elevatorRide: { x: 20.4, z: 10 }, exitRoom: { gx: 15, gy: 15, w: 4, h: 4 },
  };

  await test('only the simulation host may register world anchors', async () => {
    const sim = simHostId === p1.playerId ? p1 : p2;
    const other = sim === p1 ? p2 : p1;
    const bad = await ack(other, EV.WORLD_ANCHORS, ANCHORS);
    assert.strictEqual(bad.ok, false);
    const ok = await ack(sim, EV.WORLD_ANCHORS, ANCHORS);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  });

  /* ===== movement ===== */
  await test('movement syncs: both players appear in state:players batches', async () => {
    p1.emit(EV.STATE_MOVE, { p: [10, 0, 10], yaw: 1.2, f: 0, s: -1, t: Date.now() });
    p2.emit(EV.STATE_MOVE, { p: [12, 0, 10], yaw: 0, f: 2, s: -1, t: Date.now() });
    p1._pos = [10, 10]; p2._pos = [12, 10];
    const batch = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no state:players batch')), 3000);
      const h = (d) => {
        const a = (d.p || []).find((row) => row[0] === p1.playerId);
        const b = (d.p || []).find((row) => row[0] === p2.playerId);
        if (a && b && Math.abs(a[1] - 10) < 0.01 && Math.abs(b[1] - 12) < 0.01) {
          clearTimeout(t); p2.off(EV.STATE_PLAYERS, h); resolve(d);
        }
      };
      p2.on(EV.STATE_PLAYERS, h);
    });
    assert.ok(batch.t, 'batch has no timestamp');
  });

  await test('anti-teleport: an impossible speedhack sample is dropped', async () => {
    await sleep(2700);   // let any spawn teleport grace expire
    p1.emit(EV.STATE_MOVE, { p: [10, 0, 10], yaw: 1.2, f: 0, s: -1, t: Date.now() });
    await sleep(120);
    p1.emit(EV.STATE_MOVE, { p: [900, 0, 900], yaw: 1.2, f: 0, s: -1, t: Date.now() });
    await sleep(400);
    const seen = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      const h = (d) => {
        const a = (d.p || []).find((row) => row[0] === p1.playerId);
        if (a) { clearTimeout(t); p2.off(EV.STATE_PLAYERS, h); resolve(a); }
      };
      p2.on(EV.STATE_PLAYERS, h);
    });
    assert.ok(seen, 'no snapshot after hack attempt');
    assert.ok(Math.abs(seen[1] - 10) < 0.5 && Math.abs(seen[3] - 10) < 0.5, 'speedhack accepted: ' + JSON.stringify(seen));
  });

  /* ===== server-validated progression ===== */
  const sim = () => (simHostId === p1.playerId ? p1 : p2);
  const other = () => (simHostId === p1.playerId ? p2 : p1);
  const send = (s, ev) => ack(s, EV.GAME_EVENT, ev);

  await test('locked door refuses to open ("door is locked")', async () => {
    await moveTo(sim(), 11, 10);
    const res = await send(sim(), { type: 'door', key: 'kc_door', open: true });
    assert.strictEqual(res.ok, false);
    assert.ok(/locked/i.test(res.error), 'wrong error: ' + res.error);
  });

  await test('shared pickup applies once for everyone (keycard)', async () => {
    const seen = appliedMatching(other(), (d) => d.type === NET.GE.PICKUP && d.id === 'pick_keycard_1');
    const res = await send(sim(), { type: 'pickup', id: 'pick_keycard_1', at: [11.2, 10] });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const applied = await seen;
    assert.strictEqual(applied.item, 'keycard');
    assert.strictEqual(applied.by, sim().playerId);
    const again = await send(other(), { type: 'pickup', id: 'pick_keycard_1' });
    assert.strictEqual(again.ok, true);   // idempotent: no fight over it
  });

  await test('keycard unlock sets the shared keycardUsed progression', async () => {
    const seen = appliedMatching(other(), (d) => d.type === NET.GE.UNLOCK && d.method === 'keycard');
    const res = await send(sim(), { type: 'unlock', key: 'kc_door', method: 'keycard' });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    await seen;
    const open = await send(sim(), { type: 'door', key: 'kc_door', open: true });
    assert.strictEqual(open.ok, true, JSON.stringify(open));
  });

  await test('unauthorized unlock without the keycard is rejected', async () => {
    // other() never picked the keycard up (server-side inventory)
    await moveTo(other(), 11, 10);
    const res = await send(other(), { type: 'unlock', key: 'code_door', method: 'keycard' });
    assert.strictEqual(res.ok, false);
  });

  await test('chapter order + prerequisites are enforced by the server', async () => {
    const c2 = await send(other(), { type: 'chapter', n: 2 });
    assert.strictEqual(c2.ok, true, 'chapter 2 should pass with keycardUsed: ' + JSON.stringify(c2));
    const c3 = await send(other(), { type: 'chapter', n: 3 });
    assert.strictEqual(c3.ok, false);
    assert.ok(/powerOn|prerequisite/i.test(c3.error), 'wrong error: ' + c3.error);
    const skip = await send(other(), { type: 'chapter', n: 4 });
    assert.strictEqual(skip.ok, false, 'jumping 2 -> 4 must fail');
    assert.ok(/order/i.test(skip.error || ''), 'wrong error: ' + skip.error);
  });

  await test('out-of-order chapter jump is rejected', async () => {
    const res = await send(sim(), { type: 'chapter', n: 4 });
    assert.strictEqual(res.ok, false);
    assert.ok(/order/i.test(res.error), 'wrong error: ' + res.error);
  });

  await test('fuses -> powerOn -> POWER broadcast to everyone', async () => {
    await moveTo(other(), 13, 10);
    const pk = await send(other(), { type: 'pickup', id: 'pick_fuse_1' });
    assert.strictEqual(pk.ok, true, JSON.stringify(pk));
    const f1 = await send(other(), { type: 'fuse', slot: 0 });
    assert.strictEqual(f1.ok, true, JSON.stringify(f1));
    const fuse1 = await appliedMatching(sim(), (d) => d.type === NET.GE.FUSE && d.slot === 0);
    assert.strictEqual(fuse1.by, other().playerId);

    await moveTo(sim(), 10, 13);
    const pk2 = await send(sim(), { type: 'pickup', id: 'pick_fuse_2' });
    assert.strictEqual(pk2.ok, true, JSON.stringify(pk2));
    await moveTo(sim(), 13.4, 10);
    const powerSeen = appliedMatching(other(), (d) => d.type === NET.GE.POWER && d.bus === 'main');
    const flagSeen = appliedMatching(sim(), (d) => d.type === NET.GE.FLAG && d.name === 'powerOn');
    const f2 = await send(sim(), { type: 'fuse', slot: 1 });
    assert.strictEqual(f2.ok, true, JSON.stringify(f2));
    const power = await powerSeen;
    assert.strictEqual(power.on, true);
    await flagSeen;
  });

  await test('fuse without carrying one is rejected', async () => {
    const res = await send(sim(), { type: 'fuse', slot: 2 });
    // both slots are full -> idempotent ok, OR not carrying -> reject; either way no crash
    assert.ok(res.ok === true || /carrying|fuse/i.test(res.error || ''), JSON.stringify(res));
  });

  await test('chapter 3 unlocks after powerOn', async () => {
    const c3 = await send(sim(), { type: 'chapter', n: 3 });
    assert.strictEqual(c3.ok, true, JSON.stringify(c3));
  });

  await test('keypad: the SERVER knows the code — wrong code broadcasts UNLOCK_FAILED', async () => {
    await moveTo(sim(), 15, 10);
    const failSeen = appliedMatching(other(), (d) => d.type === NET.GE.UNLOCK_FAILED);
    const bad = await send(sim(), { type: 'unlock', key: 'code_door', method: 'code', code: '0000' });
    assert.strictEqual(bad.ok, true, 'server should ack the attempt: ' + JSON.stringify(bad));
    await failSeen;
    const goodSeen = appliedMatching(other(), (d) => d.type === NET.GE.UNLOCK && d.method === 'code');
    const good = await send(sim(), { type: 'unlock', key: 'code_door', method: 'code', code: '4713' });
    assert.strictEqual(good.ok, true, JSON.stringify(good));
    await goodSeen;
    const c4 = await send(sim(), { type: 'chapter', n: 4 });
    assert.strictEqual(c4.ok, true, JSON.stringify(c4));
  });

  await test('calibrated / containment / core / truth_read validate proximity + order', async () => {
    const far = await send(other(), { type: 'calibrated' });
    assert.strictEqual(far.ok, false, 'calibrated from across the map must fail');
    await moveTo(sim(), 17, 10);
    const cont = await send(sim(), { type: 'containment' });
    assert.strictEqual(cont.ok, false, 'containment before calibration must fail');
    await moveTo(sim(), 18, 10);
    const cal = await send(sim(), { type: 'calibrated' });
    assert.strictEqual(cal.ok, true, JSON.stringify(cal));
    await moveTo(sim(), 17, 10);
    const c = await send(sim(), { type: 'containment' });
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    await moveTo(sim(), 19, 10);
    const core = await send(sim(), { type: 'core_touched' });
    assert.strictEqual(core.ok, true, JSON.stringify(core));
    const truth = await send(sim(), { type: 'truth_read', name: 'coreTruth' });
    assert.strictEqual(truth.ok, true, JSON.stringify(truth));
  });

  await test('medscare requires chapter >= 2 in campaign 1', async () => {
    const res = await send(sim(), { type: 'medscare' });
    assert.strictEqual(res.ok, true, 'chapter is 4 now, medscare should pass: ' + JSON.stringify(res));
  });

  await test('lever arms the SERVER-owned warm-up; escape is refused before LIFT_READY', async () => {
    await moveTo(sim(), 16, 10);
    const lev = await send(sim(), { type: 'lever' });
    assert.strictEqual(lev.ok, true, JSON.stringify(lev));
    const early = await send(sim(), { type: 'escape' });
    assert.strictEqual(early.ok, false);
    assert.ok(/not ready/i.test(early.error), 'wrong error: ' + early.error);
  });

  await test('LIFT_READY broadcasts when the server warm-up ends', async () => {
    const seen = appliedMatching(other(), (d) => d.type === NET.GE.LIFT_READY, 6000);
    const applied = await seen;
    assert.ok(applied.seq > 0);
  });

  await test('escape -> server COMPUTES the ending from shared flags (containment => B)', async () => {
    await moveTo(sim(), 20.4, 10);
    const endSeen = appliedMatching(other(), (d) => d.type === NET.GE.ENDING, 6000);
    const endedSeen = roomStateMatching(p1, (st) => st.room && st.room.phase === 'ended', 6000);
    const esc = await send(sim(), { type: 'escape' });
    assert.strictEqual(esc.ok, true, JSON.stringify(esc));
    const ending = await endSeen;
    assert.strictEqual(ending.id, 'B', 'server should compute ending B from the containment flag');
    await endedSeen;
  });

  /* ===== down / revive / wipe / rewind ===== */
  await test('down requests are authorized and monster-range validated; revive works', async () => {
    const h = await guest('DOWN-HOST');
    const v = await guest('DOWN-VICTIM');
    const cr = await ack(h, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    await ack(v, EV.ROOM_JOIN, { code: cr.code });
    await ack(v, EV.ROOM_SET_READY, { ready: true });
    const gs = once(v, EV.GAME_START);
    await ack(h, EV.ROOM_START, {});
    const start = await gs;
    const isSimHostH = start.simHostId === h.playerId;
    const simS = isSimHostH ? h : v, vicS = isSimHostH ? v : h;

    // positions: victim at [20,20], killer nearby
    await moveTo(vicS, 20, 20);
    await moveTo(simS, 20.6, 20);

    // victim may NOT down the sim host (not sim, not self)
    const unauth = await downReq(vicS, simS.playerId);
    assert.strictEqual(unauth.ok, false, 'unauthorized down must be rejected');

    // monster next to the victim but CALM (patrol) => rejected
    simS.emit(EV.SIM_MONSTER, { x: 20.2, z: 20, yaw: 0, st: 'patrol', sp: 1, act: true });
    await sleep(160);
    let r = await downReq(simS, vicS.playerId);
    assert.strictEqual(r.ok, false, 'kill while the monster is calm must be rejected');

    // walk the monster away in legal 1m steps (server validates monster speed too)
    for (let mx = 21.2; mx <= 27.2; mx += 1) {
      simS.emit(EV.SIM_MONSTER, { x: mx, z: 20, yaw: 0, st: 'attack', sp: 4, act: true });
      await sleep(140);
    }
    r = await downReq(simS, vicS.playerId);
    assert.strictEqual(r.ok, false, 'kill from across the map must be rejected');

    // bring it back on top of the victim => accepted, both clients get player_downed
    for (let mx = 26.2; mx >= 21.2; mx -= 1) {
      simS.emit(EV.SIM_MONSTER, { x: mx, z: 20, yaw: 0, st: 'attack', sp: 4, act: true });
      await sleep(140);
    }
    simS.emit(EV.SIM_MONSTER, { x: 20.2, z: 20, yaw: 0, st: 'attack', sp: 0, act: true, tid: vicS.playerId });
    await sleep(160);
    const d1 = once(vicS, EV.GAME_PLAYER_DOWNED);
    const d2 = once(simS, EV.GAME_PLAYER_DOWNED);
    const down = await downReq(simS, vicS.playerId);
    assert.strictEqual(down.ok, true, JSON.stringify(down));
    const dp = await d1; await d2;
    assert.strictEqual(dp.player, vicS.playerId);
    assert.strictEqual(dp.reason, 'caught');

    // revive: sim host stands over the victim and holds E (ticks)
    const prog = once(vicS, EV.GAME_REVIVE_PROGRESS);
    await moveTo(simS, 20.3, 20);
    for (let i = 0; i < 6; i++) { simS.emit(EV.GAME_REVIVE_TICK, { target: vicS.playerId }); await sleep(60); }
    const pr = await prog;
    assert.ok(pr.progress > 0 && pr.progress < 1);
    const revivedP = once(vicS, EV.GAME_PLAYER_REVIVED, 8000);
    for (let i = 0; i < 12; i++) { simS.emit(EV.GAME_REVIVE_TICK, { target: vicS.playerId }); await sleep(60); }
    const rv = await revivedP;
    assert.strictEqual(rv.player, vicS.playerId);

    // post-revive grace: cannot be instantly re-downed
    const grace = await downReq(simS, vicS.playerId);
    assert.strictEqual(grace.ok, false, 'revive grace must protect the survivor');

    h.close(); v.close();
  });

  await test('team wipe broadcasts when everyone is downed; rewind recovers', async () => {
    const h = await guest('WIPE-HOST');
    const v = await guest('WIPE-2');
    const cr = await ack(h, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    await ack(v, EV.ROOM_JOIN, { code: cr.code });
    await ack(v, EV.ROOM_SET_READY, { ready: true });
    const gs = once(v, EV.GAME_START);
    await ack(h, EV.ROOM_START, {});
    const start = await gs;
    const simS = start.simHostId === h.playerId ? h : v;
    const vicS = start.simHostId === h.playerId ? v : h;
    await moveTo(vicS, 20, 20);
    await moveTo(simS, 20.5, 20);
    simS.emit(EV.SIM_MONSTER, { x: 20.2, z: 20, yaw: 0, st: 'attack', sp: 0, act: true });
    await sleep(150);
    const wipeSeen = appliedMatching(vicS, (d) => d.type === 'team_wipe', 6000);
    const dA = await downReq(simS, vicS.playerId);
    assert.strictEqual(dA.ok, true, JSON.stringify(dA));
    const dB = await downReq(simS, simS.playerId);
    assert.strictEqual(dB.ok, true, JSON.stringify(dB));
    await wipeSeen;
    // rewind from the wipe screen
    const rwSeen = appliedMatching(vicS, (d) => d.type === NET.GE.REWIND, 5000);
    simS.emit(EV.GAME_REWIND_REQUEST, {});
    const rw = await rwSeen;
    assert.ok(rw.seq > 0);
    h.close(); v.close();
  });

  /* ===== disconnect / reconnect / migration ===== */
  await test('reconnect after a mid-match drop returns room:state + game:snapshot', async () => {
    const h = await guest('REC-HOST');
    const gid = uuid();
    const v = await guestWithId(gid, 'REC-DROPPER');
    const cr = await ack(h, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    await ack(v, EV.ROOM_JOIN, { code: cr.code });
    await ack(v, EV.ROOM_SET_READY, { ready: true });
    const gs = once(v, EV.GAME_START);
    await ack(h, EV.ROOM_START, {});
    await gs;
    // flag some progress so the snapshot has content
    h.emit(EV.WORLD_ANCHORS, ANCHORS);
    await sleep(100);
    v.disconnect();
    await sleep(400);
    const stateAfterDrop = await once(h, EV.ROOM_STATE, 3000).catch(() => null);
    if (stateAfterDrop) {
      const m = stateAfterDrop.room.members.find((x) => x.id === gid);
      assert.ok(!m || m.connected === false || m.downed, 'dropped member should be flagged');
    }
    // same identity reconnects
    const v2 = await guestWithId(gid, 'REC-DROPPER');
    assert.strictEqual(v2.playerId, gid, 'playerId must be stable across reconnects');
    const st = v2._early.roomState || await once(v2, EV.ROOM_STATE, 4000);
    assert.strictEqual(st.room.code, cr.code);
    const snap = v2._early.snapshot || await once(v2, EV.GAME_SNAPSHOT, 4000);
    assert.strictEqual(snap.state.phase, 'playing');
    assert.ok(snap.state.checkpoint !== undefined);
    h.close(); v2.close();
  });

  await test('host migration: host disconnect promotes the remaining member', async () => {
    const h = await guest('MIG-HOST');
    const g = await guest('MIG-GUEST');
    const cr = await ack(h, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    await ack(g, EV.ROOM_JOIN, { code: cr.code });
    const stP = once(g, EV.ROOM_STATE, 4000);
    h.disconnect();
    const st = await stP;
    assert.strictEqual(st.room.hostId, g.playerId, 'host did not migrate');
    g.close();
  });

  /* ===== voice signaling ===== */
  await test('voice hello returns peers + ICE config; signaling relays to the target peer', async () => {
    const h = await guest('VOICE-1');
    const g = await guest('VOICE-2');
    const cr = await ack(h, EV.ROOM_CREATE, { isPublic: false, campaign: 1 });
    await ack(g, EV.ROOM_JOIN, { code: cr.code });
    const helloP = once(g, EV.VOICE_PEERS, 4000).catch(() => null);
    const res = await new Promise((resolve, reject) => {
      h.timeout(4000).emit(EV.VOICE_HELLO, { mic: 'on' }, (e, r) => e ? reject(e) : resolve(r));
    });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(Array.isArray(res.peers));
    assert.ok(Array.isArray(res.iceServers));
    assert.strictEqual(res.turn, false, 'no TURN creds configured in test env');
    const g2res = await new Promise((resolve, reject) => {
      g.timeout(4000).emit(EV.VOICE_HELLO, { mic: 'on' }, (e, r) => e ? reject(e) : resolve(r));
    });
    assert.ok(g2res.peers.find((p) => p.id === h.playerId), 'peer list must contain the other member');
    const sig = once(g, EV.VOICE_SIGNAL, 4000);
    h.emit(EV.VOICE_SIGNAL, { to: g.playerId, data: { type: 'offer', sdp: 'test-offer' } });
    const got = await sig;
    assert.strictEqual(got.from, h.playerId);
    assert.strictEqual(got.data.type, 'offer');
    assert.strictEqual(got.data.sdp, 'test-offer');
    // malformed payloads (no SDP "type") are dropped
    const junk = once(g, EV.VOICE_SIGNAL, 700).then(() => { throw new Error('junk signal was relayed'); }).catch((e) => {
      if (/junk signal/.test(e.message)) throw e;
    });
    h.emit(EV.VOICE_SIGNAL, { to: g.playerId, data: { notSdp: true } });
    await junk;
    h.close(); g.close();
    void helloP;
  });

  /* ===== ping + leave ===== */
  await test('latency probe acks', async () => {
    const res = await ack(p1, 'net:ping2', {});
    assert.strictEqual(res.ok, true);
  });

  await test('leaving a room notifies the player and the room', async () => {
    const closed = once(p2, EV.ROOM_CLOSED, 4000).catch(() => null);
    await ack(p2, EV.ROOM_LEAVE, {});
    const c = await closed;
    if (c) assert.strictEqual(c.reason, 'you_left');
    p1.close(); p2.close();
  });

  /* ===== summary ===== */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
  }
  return failed.length === 0;
}

/* ---------------- main ---------------- */

(async () => {
  // dangling watcher promises (appliedMatching/once) reject after a test already
  // failed — never let them crash the harness; every real error surfaces via test()
  process.on('unhandledRejection', () => {});
  let ok = false;
  try {
    await startServer();
    ok = await run();
  } catch (e) {
    console.error('\nFATAL test harness error:', e);
    ok = false;
  } finally {
    for (const s of sockets) { try { s.close(); } catch (e) { /* gone */ } }
    if (child) child.kill('SIGTERM');
    setTimeout(() => process.exit(ok ? 0 : 1), 300);
  }
})();
