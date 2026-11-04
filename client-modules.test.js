'use strict';
/* ============================================================
   THE LAST SIGNAL — client module smoke test (jsdom)
   ------------------------------------------------------------
   Loads the REAL index.html DOM (no page scripts executed),
   stubs the game's global namespaces, then evaluates the real
   mp/*.js modules in order — exactly like the browser does —
   and exercises:
     * module load + MP.Auth.init() + MP.UI.init() wiring
     * the multiplayer menu flow (missing-vendor error states)
     * every room/team/downed UI renderer against the real panels
     * the full game:applied dispatcher (all server event types)
     * down/revive/wipe/rewind client handlers
     * offline intent paths (requestEvent/requestOnce/localDeath)
   This is NOT a substitute for a real browser (no WebGL/audio),
   but it proves the client layer boots, wires every DOM id it
   references, and survives every authoritative event the server
   can broadcast.
   Run:  npm run test:client     (inside LAST-SIGNAL/server)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.stack || e.message });
    console.log(`  ✗ ${name}\n      ${(e.message || e).split('\n')[0]}`);
  }
}

/* ---------------- game-global stubs ---------------- */

function spy(fn) {
  const f = function (...a) { f.calls.push(a); return fn ? fn.apply(this, a) : undefined; };
  f.calls = [];
  return f;
}

function buildStubs(win) {
  const S = {};
  S.toast = spy(); S.objective = spy(); S.ending = spy(); S.prompt = spy();

  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x || 0, v.y || 0, v.z || 0); }
    clone() { return new Vec3(this.x, this.y, this.z); }
  }
  win.THREE = {
    Vector3: Vec3,
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.rotation = { x: 0, y: 0, z: 0 }; this.position = new Vec3(); } },
    CylinderGeometry: class { constructor() {} },
    MeshStandardMaterial: class { constructor(p) { Object.assign(this, p); } },
    Object3D: class { constructor() { this.children = []; } add(c) { this.children.push(c); } remove() {} traverse() {} },
  };

  win.CELL = 2;
  win.cw = (g) => g * 2;

  win.G = {
    state: { scene: 'menu', flags: {}, chapter: 1, campaign: 1, checkpoint: null, stress: 0, kills: 0, time: 0, diffSkill: 'hard', fakeoutDone: false },
    settings: { camShake: true, sensitivity: 1, masterVol: 1, musicVol: 1, ambientVol: 1, sfxVol: 1, brightness: 1, quality: 'high', motionFx: true, invertLook: false },
    player: {
      pos: new Vec3(10, 0, 10), yaw: 0, pitch: 0, hidden: false, hideSpot: null, dead: false,
      crouching: false, sprinting: false, flashlightOn: false, battery: 100, hasFlashlight: true,
      controlLocked: false, stamina: 100, moveSpeedCur: 0, noiseWhileHidden: false,
      camera: { position: new Vec3(10, 1.6, 10), getWorldDirection: (v) => v.set(0, 0, -1), fov: 72 },
      shake: spy(), respawn: spy(), triggerHandAnim: spy(), startDeath: spy(), toggleFlashlight() {}, useBattery() {}, look() {},
    },
    inv: { items: [], add: spy(), remove: spy(), count: () => 0, has: () => false, serialize: () => [] },
    bus: { on: spy(), emit: spy() },
    noise: spy(),
    debug: { godMode: false },
    fusePanel: null, containmentConsole: null, signalCore: null, elevatorLever: null, freqTerminal: null,
  };

  win.UI = {
    toast: S.toast, setObjective: S.objective, setPrompt: S.prompt,
    endingScreen: S.ending, deathScreen: spy(), showMessage: spy(), monCaption: spy(),
    hideWarning: spy(), flashWhite: spy(), closeAllPanels: spy(), chapterCard: spy(),
    hideSkillCheck: spy(), fearVignette: spy(), hideOverlay: spy(), openKeypad: spy(),
    syncSettingsUI: spy(), showMenu: spy(), getProgress: () => ({ completed: [], unlocked: 1, endings: {} }),
    _keyInput: '', _keyDoor: null,
  };

  win.MAIN = {
    _frameBody: spy(), requestLock: spy(), restartCheckpoint: spy(), toMenu: spy(),
    beginEndingSequence: spy(), addStatic: spy(), distortPulse: spy(),
    applyQuality: spy(), applyMotionFx: spy(), applyBrightness: spy(),
    renderer: null, scene: null, ambient: null, menuWhisper: spy(),
  };

  win.MON = {
    update: spy(), setState: spy(), pos3: () => ({ x: 0, y: 0, z: 0 }),
    forceRetreat: spy(), activateFull: spy(), enableGlimpse: spy(), startAggroLock: spy(),
    onSkillResult: spy(), _animate: spy(), _audio: spy(),
    soundEvents: [], model: { visible: true, position: new Vec3() },
    pos: new Vec3(), yaw: 0, active: false, state: 'idle', speed: 0, suspicion: 0,
    glimpseMode: false, aggroLock: false, adapt: { lockerTaste: 0, hides: 0, sprints: 0, flashlight: 0, noiseHidden: 0 },
    breathLoop: null, inspectPhase: null, inspectSpot: null, lungeT: 0, path: null, target: null, pathIdx: 0,
    lastSound: null, lastKnown: null, searchCenter: null, searchT: 0, homeNode: new Vec3(),
  };

  win.WORLD = {
    doors: [], interactables: [], hideSpots: [], fixtures: [], cameras: [],
    power: {}, navLockKeys: new Set(),
    openDoor: spy(), closeDoor: spy(), setPower: spy(),
    regionAt: () => null, nearestOpen: (x, z) => ({ x, z }),
    circleCollide: (x, z) => ({ x, z }), center: () => null, radioPos: { x: 0, z: 0 },
  };

  win.STORY = {
    save: spy(), onDoorUnlocked: spy(), onPickup: spy(), pullLever: spy(),
    elevatorReady: spy(), genericLeverReady: spy(), onCalibrated: spy(), touchCore: spy(),
    enterChapter2: spy(), enterChapter3: spy(), enterChapter4: spy(), medScare: spy(),
    checkpoint: spy(), setCheckpointWorld: spy(), hintPower: spy(), lobbyBeat: spy(),
    firstSkillCheck: false, medScareDone: false, _beats: {}, _completing: false,
    generic: null, started: false, warmup: 0, COMPLETE_TEXT: {},
  };

  win.DIRECTOR = { pickEvent: spy((s) => 'calm'), scheduleSoon: spy(), update: spy(), t: 0, nextEvent: 99 };
  win.AUD = {
    init: spy(), resume: spy(), play: spy(() => ({ setPos() {}, stop() {} })),
    setSilence: spy(), setMuffled: spy(), music: { stop: spy() }, applySettings: spy(), sfx: {},
  };
  win.INTERACT = { focus: null, busy: false, update: spy(), use: spy() };
  win.HIDE = { phase: 'none', cues: false, spot: null, forceOut: spy(), enter: spy(), exitPrompt: () => null, _peek: null };
  win.SKILL = { active: false, start: spy(), finish: spy(), press: spy(), spot: null, diff: 'moderate' };
  win.GEN = { CHAPTERS: { 2: { title: 'THE OBSERVATION WING' }, 3: { title: 'BELOW THE FOUNDATION' } }, last: null, stepList: () => [], OBJ_TEXT: {} };
  win.MAP = { checkpoints: { 1: { gx: 1, gy: 1, yaw: 0 }, 2: { gx: 5, gy: 5, yaw: 1 } }, regions: [] };
  win.STORE = { get: () => null, set: spy(), del: spy() };
  win.ENDINGS = { A: { title: 'ENDING A — ESCAPE', text: 'a' }, B: { title: 'ENDING B — CONTAINMENT', text: 'b' }, C: { title: 'ENDING C — THE SIGNAL', text: 'c' } };
  win.TEX = { screen: spy(() => ({ isTexture: true })) };
  win.PROPS = { terminals: {} };
  win.saveSettings = spy();
  win.$ = (id) => win.document.getElementById(id);
  win.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  return S;
}

/* ---------------- boot ---------------- */

async function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    resources: undefined,
  });
  const win = dom.window;
  win.console.warn = () => {};            // silence expected degradation warnings
  const origError = console.error;
  win.console.error = () => {};
  const S = buildStubs(win);

  const loadOrder = [
    'shared/network-events.js',
    'mp/config.js', 'mp/auth.js', 'mp/net.js', 'mp/voice.js',
    'mp/remote-players.js', 'mp/game-hooks.js', 'mp/ui.js',
  ];
  for (const f of loadOrder) {
    win.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  return { win, S, dom, restore: () => { console.error = origError; } };
}

/* ---------------- suite ---------------- */

(async () => {
  process.on('unhandledRejection', () => {});
  console.log('\nTHE LAST SIGNAL — client module smoke test (jsdom)\n');

  let ctx;
  await test('all mp modules evaluate against the real index.html DOM', async () => {
    ctx = await boot();
    const { win } = ctx;
    assert.ok(win.LS_NET && win.LS_NET.EV, 'LS_NET missing');
    assert.ok(win.MP && win.MP.Game && win.MP.UI && win.MP.Net && win.MP.Auth && win.MP.Voice && win.MP.Remote, 'MP namespace incomplete');
  });

  await test('MP.Auth.init + MP.UI.init boot; every control gets wired', async () => {
    const { win } = ctx;
    win.MP.Auth.init();                       // no supabase vendor -> graceful warn path
    win.MP.UI.init();                         // wraps stubs + wires every onclick
    const $ = (id) => win.document.getElementById(id);
    for (const id of ['mpBtn', 'mpSignInBtn', 'mpSignUpBtn', 'mpAuthBack', 'mpDevBtn', 'mpCreateBtn',
      'mpJoinBtn', 'mpRefreshBtn', 'mpHubBack', 'mpSignOutBtn', 'mpServerBtn', 'mpCopyCode',
      'mpReadyBtn', 'mpStartBtn', 'mpLeaveBtn', 'mpMicBtn', 'mpDownedBtn']) {
      const el = $(id);
      assert.ok(el, 'missing #' + id);
      assert.strictEqual(typeof el.onclick, 'function', id + ' has no click handler');
    }
    assert.strictEqual(typeof $('mpCampaignSel').onchange, 'function');
  });

  await test('openMultiplayer without the socket.io vendor shows a clear network error', async () => {
    const { win } = ctx;
    delete win.io;
    win.MP.UI.openMultiplayer();
    const $ = (id) => win.document.getElementById(id);
    assert.ok(!$('mpAuthPanel').classList.contains('hidden'), 'auth panel should be visible');
    assert.ok($('menu').classList.contains('hidden'), 'menu should hide');
    assert.match($('mpAuthStatus').textContent, /networking library missing/i);
  });

  await test('with the io vendor present, the auth panel offers the dev-guest path', async () => {
    const { win } = ctx;
    win.io = function stubIo() { throw new Error('no real connects in jsdom'); };
    win.MP.UI.openMultiplayer();
    const $ = (id) => win.document.getElementById(id);
    assert.ok(!$('mpAuthPanel').classList.contains('hidden'));
    assert.ok(!$('mpDevBtn').classList.contains('hidden'), 'dev button should show when supabase vendor is absent');
    assert.match($('mpAuthStatus').textContent, /supabase library missing/i);
  });

  await test('connection-state chips render every CONN state', async () => {
    const { win } = ctx;
    const C = win.LS_NET.CONN;
    const cases = [[C.CONNECTED, 'CONNECTED', 'ok'], [C.CONNECTING, 'CONNECTING...', 'warn'],
      [C.RECONNECTING, 'RECONNECTING...', 'warn'], [C.FAILED, 'CONNECTION FAILED', 'bad'], [C.OFFLINE, 'OFFLINE', 'warn']];
    for (const [state, text, cls] of cases) {
      win.MP.UI.renderConn({ state, msg: 'x' });
      const chip = win.document.getElementById('mpConnChipAuth');
      assert.strictEqual(chip.textContent, text);
      assert.ok(chip.className.includes(cls), `${state} -> ${chip.className}`);
    }
    assert.strictEqual(win.document.getElementById('mpConnMsg').textContent, 'x');
  });

  await test('mic chip degrades to VOICE UNSUPPORTED without WebRTC (jsdom)', async () => {
    const { win } = ctx;
    win.MP.UI.renderMicState();
    const chip = win.document.getElementById('mpMicChip');
    assert.match(chip.textContent, /VOICE UNSUPPORTED/);
    assert.ok(chip.className.includes('bad'));
  });

  await test('renderRoom draws code, 6 slots, badges, count and phase', async () => {
    const { win } = ctx;
    win.MP.active = false;
    win.MP.playerId = 'p1';
    const room = {
      code: 'ABCDE', campaign: 1, phase: 'lobby', hostId: 'p1', simHostId: null, maxPlayers: 6,
      members: [
        { id: 'p1', name: 'RIPLEY', slot: 0, ready: true, connected: true, mic: 'on', downed: false, you: true },
        { id: 'p2', name: 'HICKS', slot: 1, ready: false, connected: true, mic: 'off', downed: false, you: false },
        { id: 'p3', name: 'GHOST', slot: 2, ready: false, connected: false, mic: 'off', downed: true, you: false },
      ],
    };
    win.MP.members = room.members;
    win.MP._lastRoom = room;
    win.MP.UI.renderRoom(room);
    const $ = (id) => win.document.getElementById(id);
    assert.strictEqual($('mpRoomCodeVal').textContent, 'ABCDE');
    assert.strictEqual($('mpRoomPlayers').children.length, 6, 'six slots must render');
    assert.strictEqual($('mpRoomCount').textContent, '2 / 6 SURVIVORS', 'count tracks connected members');
    assert.match($('mpRoomPhase').textContent, /LOBBY/);
    const html = $('mpRoomPlayers').innerHTML;
    assert.ok(html.includes('HOST') && html.includes('READY') && html.includes('STANDBY') && html.includes('RECONNECTING'), html);
    assert.ok(html.includes('(YOU)'), 'own slot must be marked');
    // host in lobby: START visible, READY toggled on
    assert.ok(!$('mpStartBtn').classList.contains('hidden'), 'host should see START');
    assert.ok($('mpReadyBtn').classList.contains('ready-on'), 'ready state should glow');
  });

  await test('non-host never sees START; playing phase hides lobby controls', async () => {
    const { win } = ctx;
    const $ = (id) => win.document.getElementById(id);
    win.MP.playerId = 'p2';
    win.MP.UI.renderRoomButtons({ code: 'ABCDE', campaign: 1, phase: 'lobby', hostId: 'p1', members: [{ id: 'p2', ready: false }] });
    assert.ok($('mpStartBtn').classList.contains('hidden'), 'non-host must not see START');
    win.MP.UI.renderRoomButtons({ code: 'ABCDE', campaign: 1, phase: 'playing', hostId: 'p1', members: [{ id: 'p2' }] });
    assert.ok($('mpReadyBtn').classList.contains('hidden') && $('mpStartBtn').classList.contains('hidden'));
    assert.strictEqual($('mpLeaveBtn').textContent, 'ABANDON EXPEDITION');
    win.MP.playerId = 'p1';
  });

  await test('team HUD lists members with status + voice/link footers', async () => {
    const { win } = ctx;
    const $ = (id) => win.document.getElementById(id);
    $('mpTeamHud').classList.remove('hidden');
    win.MP.members = [
      { id: 'p1', name: 'RIPLEY', downed: false, connected: true },
      { id: 'p2', name: 'HICKS', downed: true, connected: true },
      { id: 'p3', name: 'GHOST', downed: false, connected: false },
    ];
    win.MP.Remote.players.clear();
    win.MP.UI.refreshTeamPanel();
    const rows = $('mpTeamList').children;
    assert.strictEqual(rows.length, 3);
    assert.ok(rows[0].textContent.includes('RIPLEY') && rows[0].textContent.includes('ACTIVE'));
    assert.ok(rows[1].classList.contains('down') && rows[1].textContent.includes('DOWN'));
    assert.ok(rows[2].classList.contains('disc') && rows[2].textContent.includes('LOST SIGNAL'));
    assert.match($('mpTeamConn').textContent, /LINK|OFFLINE/i);
    assert.match($('mpTeamVoice').textContent, /VOICE OFF/);
    $('mpTeamHud').classList.add('hidden');
  });

  await test('downed overlay: show, revive progress, hide; wipe re-arms death buttons', async () => {
    const { win } = ctx;
    const $ = (id) => win.document.getElementById(id);
    win.MP.playerId = 'p1';
    win.MP.members = [{ id: 'p1', name: 'RIPLEY' }, { id: 'p2', name: 'HICKS' }];
    win.MP.UI.showDowned('caught');
    assert.ok(!$('mpDowned').classList.contains('hidden'));
    assert.strictEqual($('mpDownedTitle').textContent, 'SIGNAL LOST');
    win.MP.UI.reviveProgress({ target: 'p1', by: 'p2', progress: 0.5 });
    assert.strictEqual($('mpDownedBar').style.width, '50%');
    assert.match($('mpDownedWho').textContent, /HICKS IS REACHING FOR YOU/);
    assert.ok(!$('mpDownedRevive').classList.contains('hidden'));
    win.MP.UI.armWipeButtons();
    assert.ok($('mpDowned').classList.contains('hidden'), 'wipe hides the down overlay');
    assert.match($('deathRestart').textContent, /ALL PLAYERS/);
    assert.strictEqual(typeof $('deathRestart').onclick, 'function');
    // restore SP handlers like exitMatchUI does
    win.MP.UI.exitMatchUI();
    assert.strictEqual($('deathRestart').textContent, 'REWIND TO CHECKPOINT');
    assert.strictEqual($('deathMenu').textContent, 'ABANDON INVESTIGATION');
  });

  await test('M keybind routes to the mic toggle without throwing', async () => {
    const { win } = ctx;
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.match(win.document.getElementById('mpMicChip').textContent, /VOICE UNSUPPORTED|MIC/);
  });

  /* ===== the authoritative-event dispatcher ===== */

  await test('onApplied: flags, chapters, medscare, lever, lift_ready, truth, checkpoint', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE;
    const MP = win.MP;
    MP.active = true; MP.playerId = 'p1'; MP.campaign = 1;
    MP.members = [{ id: 'p1', name: 'RIPLEY', downed: false }, { id: 'p2', name: 'HICKS', downed: false }];
    const G = win.G, STORY = win.STORY;

    MP.Game.onApplied({ type: GE.FLAG, name: 'radioHeard', by: 'p2' });
    assert.strictEqual(G.state.flags.radioHeard, true);

    MP.Game.onApplied({ type: GE.CHAPTER, n: 2, by: 'p1' });
    assert.strictEqual(STORY.enterChapter2.calls.length, 1);
    assert.strictEqual(G.state.chapter, 2);

    MP.Game.onApplied({ type: GE.MEDSCARE, by: 'p1' });
    assert.strictEqual(STORY.medScare.calls.length, 1);

    MP.Game.onApplied({ type: GE.LEVER, warmupMs: 30000, by: 'p1' });
    assert.strictEqual(STORY.pullLever.calls.length, 1);

    MP.campaign = 1;
    MP.Game.onApplied({ type: GE.LIFT_READY, by: null });
    assert.strictEqual(STORY.elevatorReady.calls.length, 1);
    MP.campaign = 3;
    MP.Game.onApplied({ type: GE.LIFT_READY, by: null });
    assert.strictEqual(STORY.genericLeverReady.calls.length, 1);
    MP.campaign = 1;

    MP.Game.onApplied({ type: GE.TRUTH_READ, name: 'coreTruth', by: 'p2' });
    assert.strictEqual(G.state.flags.coreTruth, true);

    MP.Game.onApplied({ type: GE.CHECKPOINT, gx: 7, gy: 9, yaw: 1.5, by: 'p1' });
    assert.deepStrictEqual({ gx: G.state.checkpoint.gx, gy: G.state.checkpoint.gy, yaw: G.state.checkpoint.yaw }, { gx: 7, gy: 9, yaw: 1.5 });
    assert.strictEqual(MP.applying, false, 'applying must reset');
  });

  await test('onApplied: doors, unlocks (keycard + code), failed codes', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE, MP = win.MP, WORLD = win.WORLD, STORY = win.STORY, UI = win.UI;
    WORLD.doors = [{
      key: 'kc_door', unlocked: false, open: false, px: 11, pz: 10,
      readerMesh: { material: { emissive: { setHex: spy() } } },
    }];
    WORLD.navLockKeys.add('kc_door');

    MP.Game.onApplied({ type: GE.DOOR, key: 'kc_door', open: true, by: 'p2' });
    assert.strictEqual(WORLD.openDoor.calls.length, 1);

    MP.Game.onApplied({ type: GE.UNLOCK, key: 'kc_door', method: 'keycard', by: 'p1' });
    assert.strictEqual(WORLD.doors[0].unlocked, true);
    assert.ok(!WORLD.navLockKeys.has('kc_door'), 'nav lock must clear');
    assert.deepStrictEqual(STORY.onDoorUnlocked.calls[0], ['keycard_door']);

    WORLD.doors.push({ key: 'code_door', unlocked: false, open: false, px: 15, pz: 10, readerMesh: null });
    MP.Game.onApplied({ type: GE.UNLOCK, key: 'code_door', method: 'code', by: 'p2' });
    assert.deepStrictEqual(STORY.onDoorUnlocked.calls[1], ['code_door']);
    assert.strictEqual(UI.closeAllPanels.calls.length >= 1, true);

    // failed code for ME: buzzer + keypad display flash + toast
    UI._keyInput = '1234';
    const toastsBefore = ctx.S.toast.calls.length;
    MP.Game.onApplied({ type: GE.UNLOCK_FAILED, key: 'code_door', by: 'p1' });
    assert.strictEqual(UI._keyInput, '', 'input must clear after a failed code');
    assert.ok(ctx.S.toast.calls.length > toastsBefore, 'denial toast expected');
  });

  await test('onApplied: shared pickups (mine vs theirs)', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE, MP = win.MP, WORLD = win.WORLD, G = win.G, STORY = win.STORY;
    const removed = [];
    WORLD.interactables = [{ id: 'pk1', itemId: 'keycard', count: 1, mesh: { parent: { remove: (m) => removed.push(m) } } }];
    MP.Game.onApplied({ type: GE.PICKUP, id: 'pk1', item: 'keycard', by: 'p1' });
    assert.strictEqual(G.inv.add.calls.length, 1);
    assert.strictEqual(STORY.onPickup.calls.length, 1);
    assert.strictEqual(WORLD.interactables[0].dead, true);
    assert.strictEqual(removed.length, 1, 'mesh removed from the world');
    // someone else grabs the next one: no local inventory change
    WORLD.interactables = [{ id: 'pk2', itemId: 'fuse', count: 1, mesh: { parent: { remove: () => {} } } }];
    const addsBefore = G.inv.add.calls.length;
    MP.Game.onApplied({ type: GE.PICKUP, id: 'pk2', item: 'fuse', by: 'p2' });
    assert.strictEqual(G.inv.add.calls.length, addsBefore, 'their pickup must not touch my inventory');
    assert.strictEqual(WORLD.interactables[0].dead, true);
  });

  await test('onApplied: fuse visuals + power restoration', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE, MP = win.MP, G = win.G, WORLD = win.WORLD;
    G.fusePanel = {
      pos: { x: 1, y: 1, z: 2 },
      slots: [
        { filled: false, led: { material: { emissive: { setHex: spy() } } }, slot: { add: spy() } },
        { filled: false, led: { material: { emissive: { setHex: spy() } } }, slot: { add: spy() } },
      ],
    };
    G.inv.items.push({ id: 'fuse', count: 1 });
    MP.Game.onApplied({ type: GE.FUSE, slot: 0, by: 'p1' });
    assert.strictEqual(G.fusePanel.slots[0].filled, true);
    assert.strictEqual(G.fusePanel.slots[0].slot.add.calls.length, 1, 'fuse mesh added');
    assert.strictEqual(G.inv.remove.calls.length >= 1, true, 'my fuse consumed');

    MP.Game.onApplied({ type: GE.FLAG, name: 'powerOn', by: 'p1' });
    MP.Game.onApplied({ type: GE.POWER, bus: 'main', on: true, by: 'p1' });
    assert.deepStrictEqual(WORLD.setPower.calls[0], ['main', true]);
    assert.strictEqual(G.state.flags.powerOn, true);
  });

  await test('onApplied: calibration, containment staging, core touch', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE, MP = win.MP, G = win.G, UI = win.UI, STORY = win.STORY;
    UI._freqLockT = 5;
    MP.Game.onApplied({ type: GE.CALIBRATED, by: 'p1' });
    assert.strictEqual(G.state.flags.calibrated, true);
    assert.strictEqual(UI._freqLockT, 0, 'my lock timer resets');
    assert.strictEqual(STORY.onCalibrated.calls.length, 1);

    G.containmentConsole = { pos: { x: 0, z: 0 }, screen: { material: {} } };
    MP.isSimHost = true;
    MP.Game.onApplied({ type: GE.CONTAINMENT, by: 'p2' });
    assert.strictEqual(G.state.flags.containment, true);
    assert.strictEqual(win.MON.forceRetreat.calls.length, 1, 'sim host retreats the creature');
    assert.strictEqual(G.containmentConsole.screen.material.map.isTexture, true, 'console screen swapped');
    MP.isSimHost = false;

    MP.Game.onApplied({ type: GE.CORE_TOUCHED, by: 'p1' });
    assert.strictEqual(G.state.flags.signalTouched, true);
    assert.strictEqual(STORY.touchCore.calls.length, 1, 'toucher gets the full original sequence');
    const toasts = ctx.S.toast.calls.length;
    MP.Game.onApplied({ type: GE.CORE_TOUCHED, by: 'p2' });   // idempotent for the record
    assert.ok(ctx.S.toast.calls.length >= toasts);
  });

  await test('onApplied: server-decided ending + chapter complete + rewind + wipe', async () => {
    const { win } = ctx;
    const GE = win.LS_NET.GE, MP = win.MP, G = win.G;
    MP.Game.endingShown = false;
    MP.Game.onApplied({ type: GE.ENDING, id: 'B', by: 'p1' });
    assert.strictEqual(G.state.flags.ending, 'B');
    assert.strictEqual(ctx.S.ending.calls.length, 1);
    assert.strictEqual(ctx.S.ending.calls[0][0], 'ENDING B — CONTAINMENT');
    assert.strictEqual(typeof ctx.S.ending.calls[0][2], 'function', 'ending callback supplied');

    MP.Game.endingShown = false;
    MP.Game.onApplied({ type: GE.CHAPTER_COMPLETE, n: 2, by: 'p1' });
    assert.strictEqual(ctx.S.ending.calls.length, 2);
    assert.match(ctx.S.ending.calls[1][0], /CHAPTER 2 COMPLETE/);
    assert.strictEqual(win.STORE.set.calls.length >= 1, true, 'local progress recorded');

    G.state.checkpoint = { chapter: 1, gx: 5, gy: 5, yaw: 0 };
    G.player.dead = true;
    // regression guard: GE.REWIND must be a real constant — it was missing once,
    // so the server broadcast {type: undefined} and clients silently dropped rewinds
    assert.strictEqual(GE.REWIND, 'rewind', 'shared GE.REWIND constant must exist');
    MP.Game.onApplied({ type: GE.REWIND, checkpoint: { gx: 7, gy: 9, yaw: 1.5 }, by: null });
    assert.strictEqual(G.player.respawn.calls.length >= 1, true);
    assert.strictEqual(win.MAIN.restartCheckpoint.calls.length >= 1, true);
    assert.strictEqual(G.player.dead, false);
    assert.deepStrictEqual(
      { gx: G.state.checkpoint.gx, gy: G.state.checkpoint.gy, yaw: G.state.checkpoint.yaw },
      { gx: 7, gy: 9, yaw: 1.5 },
      'server-supplied checkpoint must win over the stale local copy');
    const rp = G.player.respawn.calls[G.player.respawn.calls.length - 1];
    assert.deepStrictEqual([rp[0], rp[1], rp[2]], [14, 18, 1.5], 'respawn at cw(gx-0.5)+CELL/2');

    MP.Game.wipeShown = false;
    MP.Game.onApplied({ type: 'team_wipe', by: null });
    const ds = win.document.getElementById('deathScreen');
    assert.ok(ds.classList.contains('on'), 'wipe shows the death screen');
    assert.match(win.document.getElementById('deathCause').textContent, /gone quiet/i);
    MP.Game.wipeShown = false;
    ds.classList.remove('on');
  });

  await test('onApplied: player_left despawns safely; unknown types are ignored', async () => {
    const { win } = ctx;
    win.MP.Game.onApplied({ type: 'player_left', player: 'nobody', by: 'p2' });
    win.MP.Game.onApplied({ type: 'totally_unknown_event', by: 'p2' });
    win.MP.Game.onApplied(null);
    assert.ok(true, 'no crash on stale/unknown events');
  });

  await test('downed/revived client handlers drive the player + overlay', async () => {
    const { win } = ctx;
    const MP = win.MP, G = win.G;
    MP.playerId = 'p1';
    MP.members = [{ id: 'p1', name: 'RIPLEY', downed: false }, { id: 'p2', name: 'HICKS', downed: false }];
    G.player.dead = false; G.state.scene = 'play';

    MP.Game.onPlayerDowned({ player: 'p1', reason: 'caught' });
    assert.strictEqual(MP.Game.iAmDowned, true);
    assert.strictEqual(G.player.startDeath.calls.length, 1, 'approved death sequence runs');
    assert.strictEqual(G.player.startDeath.calls[0][0], 'caught');

    // hidefail while inside a locker => forced out first
    win.HIDE.phase = 'inside';
    MP.members[0].downed = true;
    MP.Game.iAmDowned = false;
    MP.Game.onPlayerDowned({ player: 'p1', reason: 'hidefail' });
    assert.strictEqual(win.HIDE.forceOut.calls.length, 1);
    win.HIDE.phase = 'none';

    MP.Game.onPlayerRevived({ player: 'p1', at: [12, 10] });
    assert.strictEqual(MP.Game.iAmDowned, false);
    assert.strictEqual(G.state.scene, 'play');
    assert.strictEqual(G.player.stamina, 60);
    const last = G.player.respawn.calls[G.player.respawn.calls.length - 1];
    assert.deepStrictEqual([last[0], last[1]], [12, 10], 'revived at the server-supplied spot');
  });

  await test('offline intents fail cleanly; requestOnce dedupes then re-arms on rejection', async () => {
    const { win } = ctx;
    const MP = win.MP;
    MP.active = true; MP.applying = false; MP.Game._deathApproved = false; MP.Game.pendingDeath = null;
    win.HIDE.phase = 'none';

    // no socket at all: the ack fires synchronously with {ok:false}
    MP.Net.socket = null;
    let rejected = 0;
    MP.Game.requestEvent('lever', {}, { onRejected: () => rejected++ });
    assert.strictEqual(rejected, 1, 'offline request must invoke onRejected');

    // fake connected socket whose acks always refuse
    let emits = 0;
    const fakeAckSocket = {
      connected: true,
      emit() {},
      timeout: () => ({ emit: (ev, p, cb) => { emits++; setTimeout(() => cb(null, { ok: false, error: 'rejected' }), 0); } }),
    };
    MP.Net.socket = fakeAckSocket;

    MP.Game._sentOnce.clear();
    MP.Game.requestOnce('core_touched');
    MP.Game.requestOnce('core_touched');       // same frame: deduped
    assert.strictEqual(emits, 1, 'second one-shot intent must be deduped while the first is in flight');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(MP.Game._sentOnce.size, 0, 'refusal must re-arm the one-shot so region triggers can retry');

    // death is server-gated: queued, never applied locally; refusal => survive & recover
    win.G.player.controlLocked = true;
    const queued = MP.Game.localDeathRequested('caught');
    assert.strictEqual(queued, true, 'death is queued, never applied locally');
    assert.strictEqual(MP.Game.pendingDeath, 'caught');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(MP.Game.pendingDeath, null, 'refusal clears the pending death');
    assert.strictEqual(win.G.player.controlLocked, false, 'controls unlock after a refused death');
    assert.ok(ctx.S.toast.calls.some((c) => /tear yourself loose/i.test(c[0])), 'survival toast shown');

    MP.Net.socket = null;
    MP.active = false;
  });

  await test('inspect relay helpers behave for local/remote/empty spots', async () => {
    const { win } = ctx;
    const MP = win.MP;
    MP.active = true; MP.playerId = 'p1'; MP.isSimHost = true;
    const spotA = { pos: { x: 1, y: 0, z: 1 }, yaw: 0 };
    const spotB = { pos: { x: 2, y: 0, z: 2 }, yaw: 0 };
    win.WORLD.hideSpots = [spotA, spotB];
    // remote player hidden in spotB
    MP.Remote.players.set('p2', { draw: { x: 2, y: 0, z: 2, yaw: 0 }, hidden: true, spotIdx: 1, crouch: false, downed: false, flash: false });
    MP.members = [{ id: 'p1', name: 'A', downed: false }, { id: 'p2', name: 'B', downed: false }];
    assert.strictEqual(MP.Game.hiderAt(spotB).id, 'p2');
    assert.strictEqual(MP.Game.hiderAt(spotA), null, 'empty spot -> null');
    // relaying needs a socket; without one it must not throw and must not claim success
    MP.Net.socket = null;
    const relayed = MP.Game.relayInspect('windup', spotB);
    assert.strictEqual(relayed, true, 'remote hider => event consumed for relay');
    assert.strictEqual(MP.Game.relayInspect('windup', spotA), false, 'nobody there => original guards run');
    // local hider => run locally
    win.G.player.hidden = true; win.G.player.hideSpot = spotA; win.G.player.dead = false; MP.Game.iAmDowned = false;
    assert.strictEqual(MP.Game.relayInspect('windup', spotA), false, 'local hider => local cues');
    win.G.player.hidden = false; win.G.player.hideSpot = null;
    MP.Remote.players.clear();
    MP.isSimHost = false; MP.active = false;
  });

  /* ===== summary ===== */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} client tests passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}\n    ${f.err.split('\n').slice(0, 4).join('\n    ')}`);
  }
  if (ctx && ctx.win) ctx.win.close();
  setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
})().catch((e) => { console.error('FATAL harness error:', e); process.exit(1); });
