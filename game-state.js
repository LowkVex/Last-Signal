/* ============================================================
   THE LAST SIGNAL — game server: authoritative shared state
   ------------------------------------------------------------
   One GameState per room. The SERVER decides every important
   gameplay outcome: objective/flag order, door unlocks, shared
   pickups, chapter transitions, the extraction timer, downs /
   revives / team wipes and which ending the team gets.

   Clients only send *intents* (game:event). Every intent is
   validated here against:
     - the campaign's objective graph (strict ordering),
     - canonical world anchors reported once by the sim host
       (door codes, key positions, region bounds),
     - the server's own record of every player's position
       (proximity checks — you cannot unlock a door across the map),
     - server-side inventory of progression items (keycard/fuses:
       you can only use what the server saw YOU pick up),
     - one-shot idempotency + rate limits.
   Only then is the event applied and broadcast (game:applied).
   ============================================================ */
'use strict';

const { GE } = require('../shared/network-events');

const MAX_SPEED = 7.5;          // m/s hard cap for player movement validation (sprint is 5.05)
const MON_MAX_SPEED = 10;       // m/s cap for monster snapshots (hunt ~4.9 * difficulty)
const INTERACT_RANGE = 3.6;     // m — proximity needed to act on an anchor
const REVIVE_RANGE = 3.2;       // m
const REVIVE_TICKS = 12;        // ~3s at 4 ticks/s
const DOWN_GRACE_MS = 2600;     // invulnerability after revive
const LIFT_WARMUP_MS = Math.max(1000, +process.env.LIFT_WARMUP_MS || 30000);   // extraction warm-up owned by the SERVER clock

/** Objective graphs. `flags` are one-shot; order enforced via `requires`. */
const GRAPH_CH1 = {
  // bespoke chapter 1: internal chapters 1..5 then ending
  flags: ['keycardUsed', 'powerOn', 'knowsCode', 'calibrated', 'containment', 'signalTouched', 'truthRead', 'coreTruth', 'leverPulled', 'liftReady', 'medScare', 'hideHint', 'radioHeard'],
  chapters: [1, 2, 3, 4, 5],
  rules: {
    keycardUsed:  { requiresPickup: 'keycard', requiresDoorType: 'keycard' },
    powerOn:      { requiresFuses: 2 },
    calibrated:   { minChapter: 3 },
    containment:  { requiresFlags: ['calibrated'] },
    signalTouched: { anchor: 'core' },
    truthRead:    {},
    coreTruth:    {},
    medScare:     { minChapter: 2, once: true },
    leverPulled:  { minChapter: 4, anchor: 'lever', setsChapter: 5, startsWarmup: true },
    liftReady:    { serverTimed: true },
  },
  chapterRequires: { 2: ['keycardUsed'], 3: ['powerOn'], 4: ['codeUsed'], 5: [] },
  escape: { requiresFlags: ['liftReady'], anchor: 'elevatorRide' },
};

function graphForCampaign(n) {
  if (n === 1) return GRAPH_CH1;
  // generic chapters 2..8: power -> [keycard] -> [code] -> lever -> extract
  // (gate order mirrors GEN.stepList; server enforces the same sequence)
  return {
    generic: true,
    flags: ['powerOn', 'keycardUsed', 'codeUsed', 'leverPulled', 'liftReady'],
    rules: {
      powerOn:     { requiresFuses: 2 },
      keycardUsed: { requiresPickup: 'keycard', requiresDoorType: 'keycard' },
      codeUsed:    { requiresDoorType: 'code' },
      leverPulled: { requiresFlags: null, anchor: 'lever', startsWarmup: true }, // requiresFlags filled per gates below
      liftReady:   { serverTimed: true },
    },
    escape: null, // generic chapters end with chapter_complete in the exit room
    chapterComplete: { requiresFlags: ['liftReady'], region: 'exitRoom' },
  };
}

/** gates for generic campaigns — mirrors GEN.CHAPTERS[n].gates (static content data) */
const GENERIC_GATES = {
  2: ['powered', 'keycard', null, null],
  3: ['powered', null, 'code', null],
  4: ['powered', 'keycard', 'code'],
  5: ['powered', 'keycard', null, 'code'],
  6: ['powered', null, 'keycard'],
  7: ['powered', 'keycard', 'code', null],
  8: ['powered', 'keycard', 'code', null],
};

function genericStepList(n) {
  const gates = GENERIC_GATES[n] || [];
  const steps = ['power'];
  const seen = {};
  for (const g of gates) if (g && (g === 'keycard' || g === 'code') && !seen[g]) { seen[g] = 1; steps.push(g); }
  steps.push('lever', 'extract');
  return steps;
}

class GameState {
  constructor(room) {
    this.room = room;                      // { code, campaign, members:Map, io, ... } handled by rooms.js
    this.reset(room.campaign || 1);
  }

  reset(campaign) {
    this.campaign = campaign || 1;
    this.graph = graphForCampaign(this.campaign);
    if (this.graph.generic) {
      // enforce gate order for generic campaigns: lever requires all gate steps done
      const steps = genericStepList(this.campaign);
      const req = [];
      for (const s of steps) {
        if (s === 'lever') break;
        if (s === 'power') req.push('powerOn');
        if (s === 'keycard') req.push('keycardUsed');
        if (s === 'code') req.push('codeUsed');
      }
      this.graph.rules.leverPulled.requiresFlags = req;
    }
    this.phase = 'lobby';                  // lobby | playing | ended
    this.chapter = campaign === 1 ? 1 : 2; // internal chapter counter (matches G.state.chapter semantics)
    this.flags = {};                       // shared story flags (server-owned)
    this.doors = {};                       // key -> {unlocked, open}
    this.pickupsTaken = {};                // pickupId -> takerPlayerId
    this.playerItems = {};                 // playerId -> {keycard:0|1, fusesHeld:n, fusesUsed:n}
    this.fusesInstalled = 0;
    this.monster = null;                   // last validated sim:monster snapshot
    this.anchors = null;                   // canonical world points from sim host
    this.checkpoint = null;                // {gx, gy, yaw}
    this.seq = 0;
    this.warmupEndsAt = 0;
    this.warmupTimer = null;
    this.wiped = false;
    this.ending = null;
    this.eventTimes = new Map();           // playerId -> [timestamps] (rate limit)
    this.startedAt = 0;
  }

  /* ---------------- player state helpers ---------------- */

  items(playerId) {
    if (!this.playerItems[playerId]) this.playerItems[playerId] = { keycard: 0, fusesHeld: 0, fusesUsed: 0 };
    return this.playerItems[playerId];
  }

  /** Register latest validated movement. Called by rooms.js. */
  setPlayerPos(playerId, x, y, z) {
    const m = this.room.members.get(playerId);
    if (!m) return;
    const now = Date.now();
    if (m.pos) {
      const dt = Math.max(0.03, (now - (m.posT || now)) / 1000);
      const d = Math.hypot(x - m.pos[0], z - m.pos[2]);
      if (d / dt > MAX_SPEED && !m.teleportOk) return false;  // impossible speed -> reject sample
    }
    m.pos = [x, y, z];
    m.posT = now;
    return true;
  }

  allowTeleport(playerId, ms = 2500) {
    const m = this.room.members.get(playerId);
    if (!m) return;
    m.teleportOk = true;
    clearTimeout(m._tpTimer);
    m._tpTimer = setTimeout(() => { m.teleportOk = false; }, ms);
  }

  posOf(playerId) {
    const m = this.room.members.get(playerId);
    return m && m.pos ? m.pos : null;
  }

  /* ---------------- anchors ---------------- */

  setAnchors(playerId, anchors) {
    if (!this.room.isSimHost(playerId)) return { ok: false, error: 'only the simulation host may register world anchors' };
    if (!anchors || typeof anchors !== 'object') return { ok: false, error: 'bad anchors' };
    // sanitize: keep only what we validate with, hard caps on sizes
    const A = {
      campaign: this.campaign,
      doors: Array.isArray(anchors.doors) ? anchors.doors.slice(0, 64).map(d => ({
        key: String(d.key || '').slice(0, 80), type: String(d.type || 'plain').slice(0, 16),
        code: d.code ? String(d.code).slice(0, 8) : null, x: +d.x || 0, z: +d.z || 0,
      })) : [],
      pickups: Array.isArray(anchors.pickups) ? anchors.pickups.slice(0, 96).map(p => ({
        id: String(p.id || '').slice(0, 80), item: String(p.item || '').slice(0, 24), x: +p.x || 0, z: +p.z || 0,
      })) : [],
      regions: Array.isArray(anchors.regions) ? anchors.regions.slice(0, 96).map(r => ({
        id: String(r.id || '').slice(0, 32), x: +r.x || 0, y: +r.y || 0, w: +r.w || 0, h: +r.h || 0, zone: String(r.zone || '').slice(0, 4),
      })) : [],
      hideSpots: Array.isArray(anchors.hideSpots) ? anchors.hideSpots.slice(0, 96).map(h => ({ x: +h.x || 0, z: +h.z || 0 })) : [],
      spawn: anchors.spawn && isFinite(+anchors.spawn.x) ? { x: +anchors.spawn.x, z: +anchors.spawn.z } : null,
      bounds: anchors.bounds && isFinite(+anchors.bounds.minX) ? {
        minX: +anchors.bounds.minX, maxX: +anchors.bounds.maxX, minZ: +anchors.bounds.minZ, maxZ: +anchors.bounds.maxZ,
      } : null,
    };
    for (const k of ['fusePanel', 'lever', 'console', 'freq', 'core', 'elevator', 'elevatorRide', 'exitRoom']) {
      const v = anchors[k];
      if (v && isFinite(+v.x)) A[k] = { x: +v.x, z: +v.z, w: v.w !== undefined ? +v.w : undefined, h: v.h !== undefined ? +v.h : undefined, gx: v.gx, gy: v.gy };
    }
    this.anchors = A;
    return { ok: true };
  }

  doorByKey(key) { return this.anchors ? this.anchors.doors.find(d => d.key === key) : null; }
  pickupById(id) { return this.anchors ? this.anchors.pickups.find(p => p.id === id) : null; }

  /* ---------------- monster snapshots ---------------- */

  acceptMonster(playerId, m) {
    if (!this.room.isSimHost(playerId)) return false;
    if (!m || !isFinite(+m.x) || !isFinite(+m.z)) return false;
    if (this.monster) {
      const dt = Math.max(0.05, (Date.now() - (this.monster._t || Date.now())) / 1000);
      const d = Math.hypot(+m.x - this.monster.x, +m.z - this.monster.z);
      if (d / dt > MON_MAX_SPEED) return false;   // implausible monster teleport -> drop sample
    }
    this.monster = {
      x: +m.x, z: +m.z, yaw: +m.yaw || 0, st: String(m.st || 'dormant').slice(0, 16),
      sp: Math.min(MAX_SPEED, Math.max(0, +m.sp || 0)), act: !!m.act, gl: !!m.gl, ag: !!m.ag,
      isp: m.isp === undefined || m.isp === null ? -1 : (m.isp | 0), iph: String(m.iph || '').slice(0, 12),
      lt: +m.lt || 0, tid: m.tid ? String(m.tid) : null, _t: Date.now(),
    };
    return true;
  }

  /* ---------------- rate limiting ---------------- */

  rateOk(playerId, limit = 25, windowMs = 5000) {
    const now = Date.now();
    let arr = this.eventTimes.get(playerId);
    if (!arr) { arr = []; this.eventTimes.set(playerId, arr); }
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    return true;
  }

  /* ---------------- THE validator ---------------- */

  /**
   * Validate a gameplay intent. Returns {ok:true, applied:{type,...}} to broadcast,
   * or {ok:false, error} — the caller (rooms.js) turns that into an ack + optional
   * side-effect broadcast (e.g. unlock_failed).
   */
  handleEvent(playerId, ev) {
    const out = { ok: false, error: 'rejected' };
    if (this.phase !== 'playing') return { ...out, error: 'match not running' };
    const member = this.room.members.get(playerId);
    if (!member || member.downed) return { ...out, error: 'not an active player' };
    if (!this.rateOk(playerId)) return { ...out, error: 'rate limited' };
    if (!ev || typeof ev.type !== 'string') return { ...out, error: 'bad event' };

    const at = Array.isArray(ev.at) && ev.at.length === 2 && isFinite(+ev.at[0]) && isFinite(+ev.at[1])
      ? [+ev.at[0], +ev.at[1]] : null;
    const pos = this.posOf(playerId) || (at ? [at[0], 0, at[1]] : null);
    const near = (p, range = INTERACT_RANGE) => !!pos && !!p && Math.hypot(pos[0] - p.x, pos[2] - p.z) <= range;

    switch (ev.type) {

      /* ---- world door open/close ---- */
      case GE.DOOR: {
        const key = String(ev.key || '').slice(0, 80);
        const d = this.doorByKey(key);
        if (!d) return { ...out, error: 'unknown door' };
        if (!near(d)) return { ...out, error: 'too far from door' };
        const st = this.doors[key] || (this.doors[key] = { unlocked: d.type === 'plain', open: false });
        if (!st.unlocked) return { ...out, error: 'door is locked' };
        const open = !!ev.open;
        st.open = open;
        // always broadcast (clients may have auto-closed locally; the server state is canonical)
        return { ok: true, applied: { type: GE.DOOR, key, open } };
      }

      /* ---- unlocking doors (keycard / keypad code / power) ---- */
      case GE.UNLOCK: {
        const key = String(ev.key || '').slice(0, 80);
        const d = this.doorByKey(key);
        if (!d) return { ...out, error: 'unknown door' };
        if (!near(d)) return { ...out, error: 'too far from reader' };
        const st = this.doors[key] || (this.doors[key] = { unlocked: false, open: false });
        if (st.unlocked) return { ok: true, applied: null };
        const method = String(ev.method || '');
        if (method === 'keycard') {
          if (d.type !== 'keycard') return { ...out, error: 'not a keycard reader' };
          const it = this.items(playerId);
          if (!it.keycard) return { ...out, error: 'you do not have a keycard' };
          st.unlocked = true;
          this.setFlag('keycardUsed', playerId);
          return { ok: true, applied: { type: GE.UNLOCK, key, method: 'keycard' }, alsoFlag: 'keycardUsed' };
        }
        if (method === 'code') {
          if (d.type !== 'code') return { ...out, error: 'not a keypad door' };
          // THE SERVER KNOWS THE CODE. Clients never decide this.
          if (!d.code || String(ev.code || '') !== d.code) {
            return { ok: true, applied: { type: GE.UNLOCK_FAILED, key } };  // broadcast the buzzer + noise
          }
          st.unlocked = true;
          this.setFlag('codeUsed', playerId);
          return { ok: true, applied: { type: GE.UNLOCK, key, method: 'code' }, alsoFlag: 'codeUsed' };
        }
        return { ...out, error: 'unknown unlock method' };
      }

      /* ---- shared world pickups ---- */
      case GE.PICKUP: {
        const id = String(ev.id || '').slice(0, 80);
        const p = this.pickupById(id);
        if (!p) return { ...out, error: 'unknown pickup' };
        if (this.pickupsTaken[id]) return { ok: true, applied: null };        // someone beat you to it
        if (!near(p, 2.8)) return { ...out, error: 'too far from item' };
        this.pickupsTaken[id] = playerId;
        const it = this.items(playerId);
        if (p.item === 'keycard') it.keycard = 1;
        if (p.item === 'fuse') it.fusesHeld += 1;
        return { ok: true, applied: { type: GE.PICKUP, id, item: p.item } };
      }

      /* ---- fuse installation (progression) ---- */
      case GE.FUSE: {
        if (!this.anchors || !this.anchors.fusePanel) return { ...out, error: 'no fuse panel in this chapter' };
        if (!near(this.anchors.fusePanel)) return { ...out, error: 'too far from panel' };
        const it = this.items(playerId);
        if (it.fusesHeld - it.fusesUsed < 1) return { ...out, error: 'you are not carrying a fuse' };
        if (this.fusesInstalled >= 2) return { ok: true, applied: null };
        const slot = this.fusesInstalled;
        it.fusesUsed += 1;
        this.fusesInstalled += 1;
        const applied = [{ type: GE.FUSE, slot, by: playerId }];
        if (this.fusesInstalled >= 2) {
          this.setFlag('powerOn', playerId);
          this.unlockDoorsOfType('powered');
          applied.push({ type: GE.FLAG, name: 'powerOn' });
          applied.push({ type: GE.POWER, bus: 'main', on: true });
        }
        return { ok: true, applied };
      }

      /* ---- frequency calibration (server checks proximity to the terminal) ---- */
      case GE.CALIBRATED: {
        const rule = this.checkRule('calibrated');
        if (!rule.ok) return rule;
        if (this.anchors && this.anchors.freq && !near(this.anchors.freq, 4.5)) return { ...out, error: 'too far from terminal' };
        if (this.flags.calibrated) return { ok: true, applied: null };
        this.setFlag('calibrated', playerId);
        return { ok: true, applied: { type: GE.CALIBRATED } };
      }

      /* ---- containment console commit ---- */
      case GE.CONTAINMENT: {
        if (!this.flags.calibrated) return { ...out, error: 'console is not calibrated' };
        if (this.flags.containment) return { ok: true, applied: null };
        if (this.anchors && this.anchors.console && !near(this.anchors.console, 4.5)) return { ...out, error: 'too far from console' };
        this.setFlag('containment', playerId);
        return { ok: true, applied: { type: GE.CONTAINMENT } };
      }

      /* ---- signal core touch ---- */
      case GE.CORE_TOUCHED: {
        if (this.anchors && this.anchors.core && !near(this.anchors.core, 4.0)) return { ...out, error: 'too far from the core' };
        if (this.flags.signalTouched) return { ok: true, applied: null };
        this.setFlag('signalTouched', playerId);
        return { ok: true, applied: { type: GE.CORE_TOUCHED } };
      }

      /* ---- soft story flags read from documents/logs (cosmetic, but tracked) ---- */
      case GE.TRUTH_READ: {
        const name = ev.name === 'coreTruth' ? 'coreTruth' : 'truthRead';
        if (this.flags[name]) return { ok: true, applied: null };
        this.setFlag(name, playerId);
        return { ok: true, applied: { type: GE.TRUTH_READ, name } };
      }

      /* ---- med-bay scare trigger (first player into the med region) ---- */
      case GE.MEDSCARE: {
        if (this.campaign !== 1) return { ...out, error: 'not part of this chapter' };
        if (this.flags.medScare) return { ok: true, applied: null };
        if (this.chapter < 2) return { ...out, error: 'too early' };
        this.setFlag('medScare', playerId);
        return { ok: true, applied: { type: GE.MEDSCARE } };
      }

      /* ---- chapter transitions ---- */
      case GE.CHAPTER: {
        const n = +ev.n | 0;
        if (this.campaign !== 1) return { ...out, error: 'chapter events are internal to chapter 1' };
        if (!GRAPH_CH1.chapters.includes(n)) return { ...out, error: 'bad chapter' };
        if (n <= this.chapter) return { ok: true, applied: null };             // idempotent
        if (n !== this.chapter + 1) return { ...out, error: 'out of order' };
        const req = GRAPH_CH1.chapterRequires[n] || [];
        for (const f of req) if (!this.flags[f]) return { ...out, error: `missing prerequisite ${f}` };
        this.chapter = n;
        return { ok: true, applied: { type: GE.CHAPTER, n } };
      }

      /* ---- extraction lever ---- */
      case GE.LEVER: {
        if (this.flags.leverPulled) return { ok: true, applied: null };
        if (this.graph.generic) {
          const req = this.graph.rules.leverPulled.requiresFlags || [];
          for (const f of req) if (!this.flags[f]) return { ...out, error: `missing prerequisite ${f}` };
        } else {
          if (this.chapter < 4) return { ...out, error: 'too early' };
        }
        if (this.anchors && this.anchors.lever && !near(this.anchors.lever, 4.0)) return { ...out, error: 'too far from lever' };
        this.setFlag('leverPulled', playerId);
        if (this.campaign === 1) this.chapter = 5;
        // SERVER owns the warm-up clock
        this.warmupEndsAt = Date.now() + LIFT_WARMUP_MS;
        clearTimeout(this.warmupTimer);
        this.warmupTimer = setTimeout(() => this.finishWarmup(), LIFT_WARMUP_MS + 50);
        return { ok: true, applied: { type: GE.LEVER, warmupMs: LIFT_WARMUP_MS } };
      }

      /* ---- escape / ending (chapter 1) ---- */
      case GE.ESCAPE: {
        if (this.campaign !== 1) return { ...out, error: 'wrong campaign' };
        if (!this.flags.liftReady) return { ...out, error: 'the elevator is not ready' };
        if (this.anchors && this.anchors.elevatorRide && !near(this.anchors.elevatorRide, 4.5)
          && !(this.anchors.elevator && near(this.anchors.elevator, 4.5))) return { ...out, error: 'too far from the elevator' };
        if (this.ending) return { ok: true, applied: null };
        // SERVER decides the ending from the shared flag record
        const id = this.flags.containment ? 'B'
          : (this.flags.signalTouched && (this.flags.coreTruth || this.flags.truthRead)) ? 'C' : 'A';
        this.ending = id;
        this.phase = 'ended';
        return { ok: true, applied: { type: GE.ENDING, id } };
      }

      /* ---- generic campaign completion (reach extraction room) ---- */
      case GE.CHAPTER_COMPLETE: {
        if (!this.graph.generic) return { ...out, error: 'wrong campaign' };
        if (!this.flags.liftReady) return { ...out, error: 'extraction not ready' };
        if (this.anchors && this.anchors.exitRoom && pos) {
          // exitRoom is reported in GRID coords {gx, gy, w, h}; player pos is world (CELL = 2)
          const r = this.anchors.exitRoom, CELL = 2;
          const gx = pos[0] / CELL, gz = pos[2] / CELL;
          const okPos = gx >= r.gx - 1 && gx <= r.gx + (r.w || 6) + 1 &&
                        gz >= r.gy - 1 && gz <= r.gy + (r.h || 6) + 1;
          if (!okPos) return { ...out, error: 'not in the extraction zone' };
        }
        if (this.ending) return { ok: true, applied: null };
        this.ending = 'COMPLETE';
        this.phase = 'ended';
        return { ok: true, applied: { type: GE.CHAPTER_COMPLETE, n: this.campaign } };
      }

      /* ---- shared checkpoint updates ---- */
      case GE.CHECKPOINT: {
        if (!ev || !isFinite(+ev.gx) || !isFinite(+ev.gy)) return { ...out, error: 'bad checkpoint' };
        this.checkpoint = { gx: +ev.gx, gy: +ev.gy, yaw: +ev.yaw || 0 };
        return { ok: true, applied: { type: GE.CHECKPOINT, gx: this.checkpoint.gx, gy: this.checkpoint.gy, yaw: this.checkpoint.yaw } };
      }

      default:
        return { ...out, error: 'unknown event type' };
    }
  }

  checkRule(flag) {
    if (this.flags[flag]) return { ok: true, applied: null };
    const rule = (this.graph.rules || {})[flag];
    if (!rule) return { ok: false, error: 'unknown flag' };
    if (rule.minChapter && this.chapter < rule.minChapter) return { ok: false, error: 'too early' };
    for (const f of rule.requiresFlags || []) if (!this.flags[f]) return { ok: false, error: `missing prerequisite ${f}` };
    return { ok: true };
  }

  setFlag(name, playerId) {
    this.flags[name] = { by: playerId, at: Date.now() };
  }

  flagSet(name) { return !!this.flags[name]; }

  finishWarmup() {
    if (this.phase !== 'playing' || this.flags.liftReady) return;
    this.setFlag('liftReady', null);
    this.warmupEndsAt = 0;
    this.unlockDoorsOfType('elevator');
    this.room.broadcastApplied({ type: GE.LIFT_READY });
  }

  /** keep the server-side door registry in sync with power/lift state */
  unlockDoorsOfType(type) {
    if (!this.anchors) return;
    for (const d of this.anchors.doors) {
      if (d.type !== type) continue;
      const st = this.doors[d.key] || (this.doors[d.key] = { unlocked: false, open: false });
      st.unlocked = true;
    }
  }

  /* ---------------- down / revive / wipe ---------------- */

  requestDown(playerId, targetId, reason) {
    const target = this.room.members.get(targetId);
    if (!target) return { ok: false, error: 'no such player' };
    if (target.downed) return { ok: true, applied: null };
    if (Date.now() - (target.revivedAt || 0) < DOWN_GRACE_MS) return { ok: false, error: 'revive grace' };
    if (reason !== 'hidefail' && reason !== 'caught') reason = 'caught';

    // SERVER VALIDATION of the kill: the monster must actually be on top of the victim.
    const tp = target.pos, m = this.monster;
    if (m && m.act && tp) {
      const d = Math.hypot(m.x - tp[0], m.z - tp[2]);
      const attacking = (m.st === 'attack' || m.st === 'hunt' || m.st === 'inspect');
      if (!attacking || d > 6.5) return { ok: false, error: 'kill rejected: monster not in range' };
    } else if (m && !m.act) {
      return { ok: false, error: 'kill rejected: monster inactive' };
    }
    target.downed = true;
    target.downReason = reason;
    target.downAt = Date.now();
    target.reviveTicks = 0;
    this.checkWipe();
    return { ok: true, applied: { type: 'player_downed', player: targetId, reason } };
  }

  reviveTick(byId, targetId) {
    const by = this.room.members.get(byId);
    const target = this.room.members.get(targetId);
    if (!by || !target || !target.downed || by.downed) return { ok: false };
    const bp = by.pos, tp = target.pos;
    if (!bp || !tp || Math.hypot(bp[0] - tp[0], bp[2] - tp[2]) > REVIVE_RANGE) return { ok: false, error: 'too far' };
    target.reviveTicks = (target.reviveTicks || 0) + 1;
    target.reviveBy = byId;
    const progress = Math.min(1, target.reviveTicks / REVIVE_TICKS);
    if (target.reviveTicks >= REVIVE_TICKS) {
      target.downed = false;
      target.revivedAt = Date.now();
      target.reviveTicks = 0;
      this.allowTeleport(targetId);
      this.wiped = false;
      return { ok: true, done: true, applied: { type: 'player_revived', player: targetId, at: [tp[0], tp[2]] } };
    }
    return { ok: true, done: false, applied: { type: 'revive_progress', by: byId, target: targetId, progress } };
  }

  checkWipe() {
    const all = [...this.room.members.values()];
    const alive = all.filter(m => !m.downed);
    if (all.length > 0 && alive.length === 0 && !this.wiped && this.phase === 'playing') {
      this.wiped = true;
      this.room.broadcastApplied({ type: 'team_wipe' });
    }
  }

  rewind() {
    for (const m of this.room.members.values()) {
      m.downed = false; m.reviveTicks = 0; m.teleportOk = true;
      clearTimeout(m._tpTimer);
      m._tpTimer = setTimeout(() => { m.teleportOk = false; }, 3000);
    }
    this.wiped = false;
    if (this.monster) this.monster = null;
    return { type: GE.REWIND, checkpoint: this.checkpoint };
  }

  /* ---------------- snapshot for joiners ---------------- */

  snapshot() {
    const flags = {};
    for (const k of Object.keys(this.flags)) flags[k] = true;
    return {
      campaign: this.campaign,
      phase: this.phase,
      chapter: this.chapter,
      flags,
      doors: this.doors,
      pickupsTaken: this.pickupsTaken,
      playerItems: this.playerItems,
      fusesInstalled: this.fusesInstalled,
      monster: this.monster ? { ...this.monster } : null,
      checkpoint: this.checkpoint,
      warmupEndsAt: this.warmupEndsAt,
      ending: this.ending,
      seq: this.seq,
    };
  }

  destroy() {
    clearTimeout(this.warmupTimer);
    for (const m of this.room.members.values()) clearTimeout(m._tpTimer);
  }
}

module.exports = { GameState, MAX_SPEED, MON_MAX_SPEED, INTERACT_RANGE, REVIVE_RANGE, REVIVE_TICKS, LIFT_WARMUP_MS, genericStepList };
