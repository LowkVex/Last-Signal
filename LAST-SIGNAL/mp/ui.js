/* ============================================================
   THE LAST SIGNAL — multiplayer client: UI layer
   ------------------------------------------------------------
   Main-menu MULTIPLAYER button -> authentication -> hub
   (create / join / browse rooms) -> room panel (code, player
   list, ready, start, mic) -> in-game team HUD, voice chip,
   connection chip, downed overlay. Everything styled with the
   game's existing panel/mbtn horror-terminal language.
   ============================================================ */
(function () {
  'use strict';

  const CONN = LS_NET.CONN;
  const U = MP.UI = {
    panelStack: [],
    readyState: false,
  };

  const $ = id => document.getElementById(id);
  const visible = id => { const e = $(id); return e && !e.classList.contains('hidden'); };
  const show = id => { const e = $(id); if (e) e.classList.remove('hidden'); };
  const hide = id => { const e = $(id); if (e) e.classList.add('hidden'); };

  U.sysToast = function (msg, dur) {
    if (window.UI && UI.toast) UI.toast(msg, dur || 4200);
    else console.log('[MP]', msg);
  };

  /* ============================================================
     init & menu button
     ============================================================ */

  U.init = function () {
    MP.Game.install();

    // main menu MULTIPLAYER button
    const btn = $('mpBtn');
    if (btn) btn.onclick = () => { AUD.init && AUD.init(); AUD.resume && AUD.resume(); AUD.play && AUD.play('uiBlip', { freq: 420 }); U.openMultiplayer(); };

    // auth panel
    $('mpSignInBtn').onclick = () => U.doSignIn();
    $('mpSignUpBtn').onclick = () => U.doSignUp();
    $('mpAuthBack').onclick = () => U.showHub();
    $('mpDevBtn').onclick = () => U.devGuestLogin();
    ['mpEmail', 'mpPass'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') U.doSignIn(); });
    });
    $('mpUsername').addEventListener('keydown', e => { if (e.key === 'Enter') U.doSignUp(); });

    // hub
    $('mpCreateBtn').onclick = () => U.doCreateRoom();
    $('mpJoinBtn').onclick = () => U.doJoinRoom();
    $('mpRefreshBtn').onclick = () => U.refreshRoomList();
    $('mpHubBack').onclick = () => U.closeAllMpPanels();
    $('mpSignOutBtn').onclick = async () => { await MP.Auth.signOut(); U.refreshAccountRow(); U.sysToast('Signed out. The facility forgets you.'); };
    $('mpJoinCode').addEventListener('keydown', e => { if (e.key === 'Enter') U.doJoinRoom(); });
    $('mpJoinCode').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    });
    const srvBtn = $('mpServerBtn');
    if (srvBtn) srvBtn.onclick = () => {
      const cur = localStorage.getItem('tls_server_url') || MP.serverUrl;
      const v = window.prompt('Game server URL (empty = same origin / default):', cur);
      if (v === null) return;
      if (v.trim() === '') localStorage.removeItem('tls_server_url');
      else localStorage.setItem('tls_server_url', v.trim().replace(/\/+$/, ''));
      location.reload();
    };

    // room panel
    $('mpCopyCode').onclick = () => U.copyRoomCode();
    $('mpReadyBtn').onclick = () => { U.readyState = !U.readyState; MP.Net.setReady(U.readyState); AUD.play('uiBlip', { freq: U.readyState ? 640 : 340 }); U.renderRoomButtons(MP._lastRoom); };
    $('mpStartBtn').onclick = () => { AUD.play('uiBlip', { freq: 700 }); MP.Net.startMatch(); };
    $('mpLeaveBtn').onclick = () => { MP.Net.leaveRoom(); };
    $('mpMicBtn').onclick = () => U.toggleMic();
    $('mpCampaignSel').onchange = (e) => MP.Net.setCampaign(parseInt(e.target.value, 10) || 1);

    // downed overlay buttons (team wipe uses the original death screen buttons, re-armed)
    const db = $('mpDownedBtn');
    if (db) db.onclick = () => { MP.Net.leaveRoom(); };

    // global keybinds: M mic, 1..5 mute teammates, E-hold revive
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { return; }
      const sc = G.state.scene;
      if (e.code === 'KeyM' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        U.toggleMic();
      }
      if (MP.active && sc === 'play' && /^Digit[1-5]$/.test(e.code)) {
        const idx = parseInt(e.code.slice(5), 10) - 1;
        const others = MP.members.filter(m => m.id !== MP.playerId);
        if (others[idx]) { MP.Voice.togglePlayerMute(others[idx].id); U.refreshTeamPanel(); }
      }
      if (MP.active && sc === 'play' && e.code === 'KeyE') {
        MP.Game._eDown = true;
        if (MP.Game.reviveFocus && !INTERACT.focus) MP.Game.startReviveHold();
      }
      if (e.code === 'Escape') {
        // close MP panels first when they are open in the menu
        if (sc === 'menu' && (visible('mpAuthPanel') || visible('mpHubPanel'))) { U.closeAllMpPanels(); e.stopImmediatePropagation(); }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyE') { MP.Game._eDown = false; MP.Game.endReviveHold(); }
    });

    // react to auth/net events
    MP.on('auth:signedIn', () => { U.refreshAccountRow(); if (visible('mpAuthPanel')) U.showHub(); });
    MP.on('auth:signedOut', () => { U.refreshAccountRow(); });
    MP.on('net:conn', (d) => U.renderConn(d));
    MP.on('room:state', (room) => { MP._lastRoom = room; U.renderRoomButtons(room); U.refreshTeamPanel(); });
    MP.on('voice:status', () => U.renderMicState());
    MP.on('voice:speaking', (d) => { MP.Remote.setSpeaking(d.id, d.speaking); U.refreshTeamPanel(true); });
    MP.on('room:closed', () => { U.closeAllMpPanels(); });
  };

  /* ============================================================
     panel flow
     ============================================================ */

  U.openMultiplayer = function () {
    U.closeGamePanels();
    if (!MP.Net.isAvailable()) {
      U.showAuth();
      U.setAuthStatus('ERROR: networking library missing. Serve the game over HTTP (the game server also hosts these files) and make sure vendor/socket.io.min.js exists.', true);
      return;
    }
    if (!MP.Auth.available) {
      U.showAuth();
      U.setAuthStatus('ERROR: Supabase library missing (vendor/supabase.umd.js). Dev-server guest login may still work below.', true);
      $('mpDevBtn').classList.remove('hidden');
      return;
    }
    if (!MP.Auth.user) U.showAuth();
    else U.showHub();
    // probe server info (dev-guest availability, TURN status) in the background
    MP.Net.pingServerInfo().then(info => {
      if (info && info.auth && info.auth.devGuestsAllowed) $('mpDevBtn').classList.remove('hidden');
      else $('mpDevBtn').classList.add('hidden');
    });
  };

  U.closeGamePanels = function () {
    ['chaptersPanel', 'creditsPanel', 'settingsPanel'].forEach(id => hide(id));
  };

  U.closeAllMpPanels = function () {
    ['mpAuthPanel', 'mpHubPanel', 'mpRoomPanel'].forEach(id => hide(id));
    if (G.state.scene === 'menu' && !MP.inRoom) show('menu');
  };

  U.showAuth = function () {
    hide('menu'); hide('mpHubPanel'); hide('mpRoomPanel');
    show('mpAuthPanel');
    U.refreshAccountRow();
    U.renderConn({ state: MP.Net.conn, msg: MP.Net.connMsg });
  };

  U.showHub = function () {
    hide('mpAuthPanel'); hide('mpRoomPanel');
    if (!MP.inRoom) { hide('menu') ; show('mpHubPanel'); }
    else { U.showRoomPanelFromMenu(); return; }
    U.refreshAccountRow();
    U.renderConn({ state: MP.Net.conn, msg: MP.Net.connMsg });
    U.refreshRoomList();
    U.ensureConnected();
  };

  U.showRoomPanelFromMenu = function () {
    hide('menu'); hide('mpAuthPanel'); hide('mpHubPanel');
    show('mpRoomPanel');
    U.renderMicState();
  };

  U.ensureConnected = async function () {
    if (MP.online) return true;
    if (MP.Auth.user) {
      const res = await MP.Net.connect({});
      if (!res.ok) U.setHubStatus(res.error || 'Could not reach the game server.', true);
      return res.ok;
    }
    return false;
  };

  /* ============================================================
     auth panel
     ============================================================ */

  U.setAuthStatus = function (msg, err) {
    const el = $('mpAuthStatus');
    el.textContent = msg || '';
    el.className = 'mp-status' + (err ? ' err' : '');
  };

  U.doSignIn = async function () {
    const email = $('mpEmail').value, pass = $('mpPass').value;
    if (!email || !pass) return U.setAuthStatus('Enter email and password.', true);
    U.setAuthStatus('Authenticating...', false);
    const res = await MP.Auth.signIn(email, pass);
    if (!res.ok) return U.setAuthStatus(res.error, true);
    U.setAuthStatus('Welcome back, ' + MP.Auth.displayName() + '.', false);
    U.showHub();
  };

  U.doSignUp = async function () {
    const email = $('mpEmail').value, pass = $('mpPass').value, uname = $('mpUsername').value.trim();
    if (!email || !pass) return U.setAuthStatus('Enter email and password.', true);
    if (uname && uname.length < 3) return U.setAuthStatus('Callsign must be at least 3 characters.', true);
    if (pass.length < 6) return U.setAuthStatus('Password must be at least 6 characters.', true);
    U.setAuthStatus('Creating account...', false);
    const res = await MP.Auth.signUp(email, pass, uname);
    if (!res.ok) return U.setAuthStatus(res.error, true);
    if (!res.confirmed) return U.setAuthStatus(res.error || 'Check your email to confirm your account, then sign in.', false);
    if (uname && !res.error) { /* username claimed inside signUp */ }
    U.setAuthStatus('Account created. Descending...', false);
    U.showHub();
  };

  U.devGuestLogin = async function () {
    U.setAuthStatus('Connecting as offline test guest...', false);
    MP.playerName = 'GUEST-' + MP.Game.devGuestId().slice(0, 4).toUpperCase();
    const res = await MP.Net.connect({ devGuest: true });
    if (!res.ok) return U.setAuthStatus(res.error || 'Dev server refused the guest connection (AUTH_MODE=dev required).', true);
    MP.dev = true;
    U.setAuthStatus('Guest session on DEV server. Progress will not be saved.', false);
    U.showHub();
  };

  U.refreshAccountRow = function () {
    const el = $('mpAccountRow');
    if (!el) return;
    if (MP.Auth.user) {
      const email = MP.Auth.user.email || '';
      el.innerHTML = `<span class="mp-acct-name">${MP.Auth.displayName()}</span><span class="mp-acct-mail">${email}</span>`;
      $('mpSignOutBtn').classList.remove('hidden');
    } else {
      el.innerHTML = `<span class="mp-acct-mail">NOT SIGNED IN</span>`;
      $('mpSignOutBtn').classList.add('hidden');
    }
  };

  /* ============================================================
     hub: create / join / browse
     ============================================================ */

  U.setHubStatus = function (msg, err) {
    const el = $('mpHubStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mp-status' + (err ? ' err' : '');
  };

  U.doCreateRoom = async function () {
    if (!(await U.ensureConnected())) return;
    const campaign = parseInt($('mpHubCampaign').value, 10) || 1;
    const isPublic = $('mpHubPublic').checked;
    U.setHubStatus('Opening a channel...', false);
    MP.Net.createRoom({ campaign, isPublic, name: MP.Auth.displayName() + "'S DESCENT" }, (res) => {
      if (!res || !res.ok) return U.setHubStatus((res && res.error) || 'Could not create the room.', true);
      MP.inRoom = true; MP.roomCode = res.code; MP.isHost = true;
      U.readyState = true;
      U.showRoomPanelFromMenu();
      U.sysToast('Room ' + res.code + ' opened. Share the code — the facility is listening.', 5200);
      if (MP.Auth.user) MP.Auth.upsertLobby({
        code: res.code, host_id: MP.Auth.user.id, name: MP.Auth.displayName() + "'S DESCENT",
        campaign, player_count: 1, max_players: 6, is_public: isPublic, status: 'lobby',
      });
    });
  };

  U.doJoinRoom = async function () {
    if (!(await U.ensureConnected())) return;
    const code = $('mpJoinCode').value.trim().toUpperCase();
    if (code.length < 4) return U.setHubStatus('Enter the 5-character room code.', true);
    U.setHubStatus('Knocking on ' + code + '...', false);
    MP.Net.joinRoom(code);
  };

  U.onJoinedRoom = function (res) {
    U.showRoomPanelFromMenu();
    U.readyState = false;
    if (res && res.code) U.sysToast('You are inside room ' + res.code + '.', 3500);
  };

  U.refreshRoomList = async function () {
    const wrap = $('mpRoomList');
    if (!wrap) return;
    wrap.innerHTML = '<div class="mp-room-empty">SCANNING FOR OPEN CHANNELS...</div>';
    MP.Net.listRooms(async (res) => {
      const rooms = (res && res.rooms) || [];
      // merge supabase lobby metadata for cross-server discovery
      let lobbies = [];
      try { lobbies = await MP.Auth.listLobbies(); } catch (e) { /* ignore */ }
      const seen = new Set(rooms.map(r => r.code));
      for (const l of lobbies) {
        if (!seen.has(l.code)) {
          rooms.push({ code: l.code, name: l.name, campaign: l.campaign, players: l.player_count, maxPlayers: 6, phase: l.status, isPublic: true, stale: true });
        }
      }
      if (!rooms.length) { wrap.innerHTML = '<div class="mp-room-empty">NO OPEN CHANNELS. CREATE A ROOM AND SEND THE CODE.</div>'; return; }
      wrap.innerHTML = '';
      for (const r of rooms.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'mp-room-row' + (r.players >= r.maxPlayers ? ' full' : '');
        row.innerHTML =
          `<span class="mp-room-code">${r.code}</span>` +
          `<span class="mp-room-name">${(r.name || 'SIGNAL ROOM').slice(0, 26)}${r.stale ? ' <i>(listed)</i>' : ''}</span>` +
          `<span class="mp-room-meta">CH${r.campaign || 1} · ${r.players}/${r.maxPlayers || 6} · ${r.phase === 'playing' ? 'IN PROGRESS' : 'LOBBY'}</span>`;
        const jb = document.createElement('button');
        jb.className = 'mbtn mp-room-join';
        jb.textContent = r.players >= (r.maxPlayers || 6) ? 'FULL' : 'JOIN';
        jb.disabled = r.players >= (r.maxPlayers || 6);
        jb.onclick = () => { $('mpJoinCode').value = r.code; U.doJoinRoom(); };
        row.appendChild(jb);
        wrap.appendChild(row);
      }
    });
  };

  /* ============================================================
     room panel
     ============================================================ */

  U.copyRoomCode = function () {
    const code = MP.roomCode || '';
    if (!code) return;
    const done = () => { const b = $('mpCopyCode'); b.textContent = 'COPIED'; setTimeout(() => { b.textContent = 'COPY CODE'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(() => U.fallbackCopy(code, done));
    else U.fallbackCopy(code, done);
    AUD.play('uiBlip', { freq: 720 });
  };

  U.fallbackCopy = function (text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); done();
    } catch (e) { U.sysToast('Room code: ' + text, 6000); }
  };

  U.renderRoom = function (room) {
    if (!room) return;
    if (MP.active) { U.refreshTeamPanel(); U.renderMicState(); return; }   // in-match: HUD only
    show('mpRoomPanel');
    $('mpRoomCodeVal').textContent = room.code || '-----';
    const me = (room.members || []).find(m => m.id === MP.playerId);
    U.readyState = !!(me && me.ready);
    // campaign selector (host, lobby only)
    const sel = $('mpCampaignSel');
    const isHostLobby = room.hostId === MP.playerId && room.phase === 'lobby';
    sel.disabled = !isHostLobby;
    if (sel.value !== String(room.campaign)) sel.value = String(room.campaign);
    $('mpRoomCampaign').textContent = 'CHAPTER ' + room.campaign + ' — ' + U.campaignName(room.campaign);
    // player list
    const wrap = $('mpRoomPlayers');
    wrap.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const m = (room.members || []).filter(x => x.connected || x.downed).sort((a, b) => a.slot - b.slot)[i];
      const row = document.createElement('div');
      row.className = 'mp-slot' + (m ? ' filled' : ' empty');
      if (m) {
        const hostTag = m.id === room.hostId ? '<span class="mp-host">HOST</span>' : '';
        const simTag = m.id === room.simHostId && room.phase === 'playing' ? '<span class="mp-sim">SIM</span>' : '';
        const readyTag = room.phase === 'lobby' ? (m.ready ? '<span class="mp-ready">READY</span>' : '<span class="mp-notready">STANDBY</span>') : '';
        const micIcon = m.mic === 'on' ? '🎙' : m.mic === 'muted' ? '🔇' : '';
        const connTag = m.connected ? '' : '<span class="mp-disc">RECONNECTING</span>';
        row.innerHTML = `<span class="mp-slot-idx">${i + 1}</span><span class="mp-slot-name">${(m.name || 'SURVIVOR').slice(0, 18)}${m.you ? ' (YOU)' : ''}</span>${hostTag}${simTag}<span class="mp-slot-mic">${micIcon}</span>${readyTag}${connTag}`;
      } else {
        row.innerHTML = `<span class="mp-slot-idx">${i + 1}</span><span class="mp-slot-name dim">— EMPTY SLOT —</span>`;
      }
      wrap.appendChild(row);
    }
    const count = (room.members || []).filter(x => x.connected).length;
    $('mpRoomCount').textContent = `${count} / 6 SURVIVORS`;
    $('mpRoomPhase').textContent = room.phase === 'playing' ? 'EXPEDITION IN PROGRESS' : room.phase === 'ended' ? 'EXPEDITION COMPLETE — READY UP TO DESCEND AGAIN' : 'LOBBY — WAITING FOR SURVIVORS';
    U.renderRoomButtons(room);
    U.renderMicState();
  };

  U.campaignName = function (n) {
    if (n === 1) return 'THE DESCENT (HOLLOW-9)';
    try { return (GEN.CHAPTERS[n] && GEN.CHAPTERS[n].title) || ('CHAPTER ' + n); } catch (e) { return 'CHAPTER ' + n; }
  };

  U.renderRoomButtons = function (room) {
    if (!room || !visible('mpRoomPanel')) return;
    const isHost = room.hostId === MP.playerId;
    const phase = room.phase;
    const me = (room.members || []).find(m => m.id === MP.playerId);
    const readyBtn = $('mpReadyBtn'), startBtn = $('mpStartBtn');
    if (phase === 'lobby' || phase === 'ended') {
      readyBtn.classList.remove('hidden');
      readyBtn.textContent = (me && me.ready) ? '✓ READY — CANCEL' : 'READY UP';
      readyBtn.classList.toggle('ready-on', !!(me && me.ready));
      startBtn.classList.toggle('hidden', !isHost);
      startBtn.disabled = !isHost;
      startBtn.textContent = 'BEGIN THE DESCENT';
    } else {
      readyBtn.classList.add('hidden');
      startBtn.classList.add('hidden');
    }
    $('mpLeaveBtn').textContent = phase === 'playing' ? 'ABANDON EXPEDITION' : 'LEAVE ROOM';
  };

  U.roomClosed = function (reason, wasInMatch) {
    U.closeAllMpPanels();
    hide('mpRoomPanel');
    MP.inRoom = false;
    if (wasInMatch) {
      MP.Game.leaveMatch(false);
      MAIN.toMenu();
    }
    show('menu');
    if (reason === 'you_left') return;
    U.sysToast('The room closed' + (reason ? ' (' + reason + ')' : '') + '.', 4500);
    U.showHub();
  };

  /* ============================================================
     in-game HUD
     ============================================================ */

  U.enterMatchUI = function () {
    hide('mpRoomPanel'); hide('mpHubPanel'); hide('mpAuthPanel');
    show('mpTeamHud'); show('mpVoiceChip');
    U.refreshTeamPanel();
    U.renderMicState();
    // rewire the pause-menu quit button for MP
    const sq = $('saveQuitBtn');
    if (sq) { sq.textContent = 'LEAVE EXPEDITION (RETURN TO ROOM)'; sq.onclick = () => { MP.Net.leaveRoom(); }; }
    // voice auto-resync on reconnect
    MP.Voice && MP.Voice.resync && MP.Voice.resync();
  };

  U.exitMatchUI = function () {
    hide('mpTeamHud');
    if (!MP.inRoom) hide('mpVoiceChip');
    U.hideDowned();
    const sq = $('saveQuitBtn');
    if (sq) { sq.textContent = 'SAVE & QUIT TO MENU'; sq.onclick = () => { STORY.save(); MAIN.toMenu(); UI.toast('Progress saved.', 2500); }; }
    // restore the original death-screen buttons (armWipeButtons rewires them during a team wipe)
    const dr = $('deathRestart'), dm = $('deathMenu');
    if (dr) { dr.textContent = 'REWIND TO CHECKPOINT'; dr.onclick = () => MAIN.restartCheckpoint(); }
    if (dm) { dm.textContent = 'ABANDON INVESTIGATION'; dm.onclick = () => MAIN.toMenu(); }
  };

  U.refreshTeamPanel = function (light) {
    const wrap = $('mpTeamList');
    if (!wrap || !visible('mpTeamHud')) return;
    const members = (MP.members || []).slice().sort((a, b) => (a.slot || 0) - (b.slot || 0));
    // rebuild only when structure changed (unless forced)
    const sig = members.map(m => `${m.id}:${m.name}:${m.downed}:${m.connected}:${m.mic}:${m.id === MP.playerId ? 1 : 0}`).join('|');
    if (!light && wrap._sig === sig) return;
    wrap._sig = sig;
    wrap.innerHTML = '';
    let idx = 0;
    for (const m of members) {
      const row = document.createElement('div');
      let cls = 'mp-team-row';
      let status = 'ACTIVE';
      const rm = MP.Remote.players.get(m.id);
      const hiddenNow = (m.id === MP.playerId) ? !!(G.player && G.player.hidden) : !!(rm && rm.hidden);
      if (m.downed) { cls += ' down'; status = 'DOWN'; }
      else if (!m.connected) { cls += ' disc'; status = 'LOST SIGNAL'; }
      else if (hiddenNow) { status = 'HIDDEN'; }
      const voice = MP.Voice.pcs.get(m.id);
      const speaking = (voice && voice.speaking) || (m.id === MP.playerId && MP.Voice.speakingLocal);
      if (speaking) cls += ' speaking';
      const micState = m.id === MP.playerId ? (MP.Voice.enabled ? (MP.Voice.muted ? 'muted' : 'mic') : 'off') : (m.mic === 'on' ? 'mic' : m.mic === 'muted' ? 'muted' : 'off');
      const keyHint = (m.id !== MP.playerId) ? `[${++idx}]` : '';
      const mutedByMe = MP.Voice.perPlayerMutes.has(m.id);
      row.className = cls;
      row.innerHTML =
        `<span class="mp-team-name">${(m.id === MP.playerId ? '▶ ' : '') + (m.name || 'SURVIVOR').slice(0, 14)}</span>` +
        `<span class="mp-team-status">${status}</span>` +
        `<span class="mp-team-mic ${micState}">${micState === 'mic' ? '🎙' : micState === 'muted' ? '✕' : '–'}${mutedByMe ? '⃠' : ''}</span>` +
        (keyHint ? `<span class="mp-team-key">${keyHint}</span>` : '');
      wrap.appendChild(row);
    }
    const conn = $('mpTeamConn');
    if (conn) {
      const label = MP.Net.conn === CONN.CONNECTED ? `LINK ${MP.Net.latency ? MP.Net.latency + 'ms' : 'OK'}` : (MP.Net.conn || '').toUpperCase();
      conn.textContent = label;
      conn.className = 'mp-team-conn ' + (MP.Net.conn === CONN.CONNECTED ? 'ok' : 'bad');
    }
    const vconn = $('mpTeamVoice');
    if (vconn) {
      const n = MP.Voice.enabled ? MP.Voice.connectedCount() : 0;
      vconn.textContent = MP.Voice.enabled ? `VOICE ${n}/${Math.max(0, members.length - 1)}` : 'VOICE OFF [M]';
      vconn.className = 'mp-team-conn ' + (MP.Voice.enabled ? (n > 0 || members.length === 1 ? 'ok' : 'warn') : '');
    }
  };

  U.renderConn = function (d) {
    const map = {
      [CONN.CONNECTED]: 'CONNECTED', [CONN.CONNECTING]: 'CONNECTING...',
      [CONN.RECONNECTING]: 'RECONNECTING...', [CONN.FAILED]: 'CONNECTION FAILED', [CONN.OFFLINE]: 'OFFLINE',
    };
    for (const id of ['mpConnChipAuth', 'mpConnChipHub', 'mpConnChipRoom']) {
      const el = $(id);
      if (el) { el.textContent = (map[d.state] || d.state || '').toUpperCase(); el.className = 'mp-conn ' + (d.state === CONN.CONNECTED ? 'ok' : d.state === CONN.FAILED ? 'bad' : 'warn'); }
    }
    const msgEl = $('mpConnMsg');
    if (msgEl) msgEl.textContent = d.msg || '';
    if (visible('mpTeamHud')) U.refreshTeamPanel();
    if (d.state === CONN.CONNECTED) {
      // re-handshake voice if we were mid-room
      if (MP.Voice && MP.Voice.enabled) MP.Voice.resync();
    }
  };

  U.renderMicState = function () {
    const V = MP.Voice;
    const chip = $('mpMicChip');
    const btn = $('mpMicBtn');
    let label = 'MIC OFF', cls = 'off';
    if (!V.isAvailable()) { label = 'VOICE UNSUPPORTED'; cls = 'bad'; }
    else if (V.status === 'requesting') { label = 'REQUESTING MIC...'; cls = 'warn'; }
    else if (V.status === 'error') { label = 'MIC ERROR'; cls = 'bad'; }
    else if (V.enabled && V.muted) { label = 'MIC MUTED'; cls = 'muted'; }
    else if (V.enabled) { label = V.speakingLocal ? 'MIC LIVE ●' : 'MIC LIVE'; cls = 'on'; }
    if (chip) { chip.textContent = label + ' [M]'; chip.className = 'mp-micchip ' + cls; }
    if (btn) { btn.textContent = V.enabled ? (V.muted ? 'UNMUTE MICROPHONE' : 'MUTE MICROPHONE') : 'ENABLE MICROPHONE'; }
    const msg = $('mpMicMsg');
    if (msg) { msg.textContent = V.statusMsg || ''; msg.className = 'mp-status' + (V.status === 'error' ? ' err' : ''); }
    U.refreshTeamPanel(true);
  };

  U.toggleMic = async function () {
    const V = MP.Voice;
    if (!V.enabled) {
      const ok = await V.enableMic();
      if (ok && MP.inRoom) MP.Net.emitRaw(LS_NET.EV.VOICE_HELLO, { mic: 'on' });
    } else {
      V.toggleMute();
    }
    U.renderMicState();
  };

  /* ---------------- downed overlay ---------------- */

  U.showDowned = function (reason) {
    show('mpDowned');
    const t = $('mpDownedTitle');
    const s = $('mpDownedSub');
    t.textContent = 'SIGNAL LOST';
    s.textContent = reason === 'hidefail'
      ? 'It found you in the dark. Your team can still pull you back — hold on.'
      : 'It caught you. Your team can still pull you back — hold on.';
    $('mpDownedBar').style.width = '0%';
    $('mpDownedRevive').classList.add('hidden');
  };

  U.hideDowned = function () { hide('mpDowned'); };

  U.reviveProgress = function (d) {
    if (d.target === MP.playerId) {
      $('mpDownedRevive').classList.remove('hidden');
      $('mpDownedBar').style.width = Math.round((d.progress || 0) * 100) + '%';
      const who = (MP.members.find(m => m.id === d.by) || {}).name || 'A survivor';
      $('mpDownedWho').textContent = who + ' IS REACHING FOR YOU';
    } else if (d.by === MP.playerId) {
      // rescuer feedback comes through the prompt (game-hooks)
    }
  };

  U.armWipeButtons = function () {
    U.hideDowned();
    const restart = $('deathRestart'), menu = $('deathMenu');
    restart.textContent = 'REWIND TO CHECKPOINT (ALL PLAYERS)';
    restart.onclick = () => { MP.Game.requestRewind(); };
    menu.textContent = 'ABANDON EXPEDITION (LEAVE ROOM)';
    menu.onclick = () => { MP.Net.leaveRoom(); MAIN.toMenu(); };
  };
})();
