/* ============================================================
   THE LAST SIGNAL — multiplayer client: Supabase auth & cloud data
   ------------------------------------------------------------
   - real email/password authentication through Supabase GoTrue
   - session restoration on return (getSession + onAuthStateChange)
   - profiles & usernames (claim_username RPC, uniqueness handled
     server-side by Postgres)
   - cloud settings + chapter progression + endings + stats
     (milestones only — movement is NEVER written to the database)
   - lobby metadata rows for public room discovery
   The game server independently VALIDATES the access token from
   this session before accepting gameplay connections; the token
   is also what binds Socket.IO identity to the Supabase user id.
   ============================================================ */
(function () {
  'use strict';

  const A = MP.Auth = {
    client: null,
    user: null,          // supabase auth user {id, email}
    profile: null,       // {username, display_color}
    progress: null,      // cloud player_progress row
    ready: false,
    available: false,
    signingIn: false,
  };

  const SUPA_URL = window.LS_CONFIG.SUPABASE_URL;
  const SUPA_KEY = window.LS_CONFIG.SUPABASE_PUBLISHABLE_KEY;

  A.available = !!(window.supabase && window.supabase.createClient && SUPA_URL && SUPA_KEY);

  function sb() { return A.client; }

  A.init = function () {
    if (!A.available) {
      console.warn('[MP.auth] supabase-js not loaded — online accounts unavailable (single-player still works)');
      return;
    }
    A.client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });

    // session restoration when the player returns
    A.client.auth.getSession().then(({ data }) => {
      if (data && data.session) A._onSession(data.session, 'INITIAL_SESSION');
      else A._onSession(null, 'NONE');
      A.ready = true;
      MP.emit('auth:ready');
    }).catch(err => {
      console.error('[MP.auth] session restore failed', err);
      A.ready = true;
      MP.emit('auth:ready');
    });

    A.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') A._onSession(session, event);
      if (event === 'SIGNED_OUT') A._onSession(null, event);
    });
  };

  A._onSession = async function (session, event) {
    if (session && session.user) {
      A.user = session.user;
      MP.dev = false;
      await A.loadProfile();
      await A.loadCloudProgress();
      A.loadCloudSettings();
      sb().rpc('touch_last_seen').then(() => {}).catch(() => {});
      MP.emit('auth:signedIn', { user: A.user, profile: A.profile });
    } else {
      A.user = null;
      A.profile = null;
      A.progress = null;
      MP.emit('auth:signedOut');
    }
  };

  /* ---------------- sign in / up / out ---------------- */

  A.signIn = async function (email, password) {
    if (!A.available) return { ok: false, error: 'Supabase client unavailable (check vendor/supabase.umd.js).' };
    A.signingIn = true; MP.emit('auth:busy', true);
    try {
      const { data, error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
      if (error) return { ok: false, error: A._friendly(error) };
      return { ok: true, user: data.user };
    } catch (e) {
      return { ok: false, error: 'Network error contacting Supabase: ' + e.message };
    } finally {
      A.signingIn = false; MP.emit('auth:busy', false);
    }
  };

  A.signUp = async function (email, password, username) {
    if (!A.available) return { ok: false, error: 'Supabase client unavailable (check vendor/supabase.umd.js).' };
    A.signingIn = true; MP.emit('auth:busy', true);
    try {
      const { data, error } = await sb().auth.signUp({
        email: email.trim(), password,
        options: { data: { username: (username || '').trim().slice(0, 20) } },
      });
      if (error) return { ok: false, error: A._friendly(error) };
      if (data.session) {
        // email confirmation not required — signed in immediately
        if (username) await A.claimUsername(username);
        return { ok: true, confirmed: true };
      }
      return { ok: true, confirmed: false, error: 'Account created. Check your email to confirm the address, then SIGN IN.' };
    } catch (e) {
      return { ok: false, error: 'Network error contacting Supabase: ' + e.message };
    } finally {
      A.signingIn = false; MP.emit('auth:busy', false);
    }
  };

  A.signOut = async function () {
    if (!A.available) return;
    try { await sb().auth.signOut(); } catch (e) { /* ignore */ }
  };

  A.friendlyError = A._friendly = function (error) {
    const m = String((error && (error.message || error)) || 'Unknown error');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Email address not confirmed yet — check your inbox.';
    if (/already registered/i.test(m)) return 'That email is already registered. Try SIGN IN.';
    if (/password should be/i.test(m)) return 'Password must be at least 6 characters.';
    if (/rate limit/i.test(m)) return 'Too many attempts — wait a minute and try again.';
    if (/failed to fetch|networkerror/i.test(m)) return 'Cannot reach Supabase (network error).';
    return m;
  };

  /* ---------------- access token (for the game server handshake) ---------------- */

  A.token = async function () {
    if (!A.available || !A.user) return null;
    const { data, error } = await sb().auth.getSession();
    if (error || !data.session) return null;
    return data.session.access_token;
  };

  /* ---------------- profile ---------------- */

  A.loadProfile = async function () {
    try {
      const { data, error } = await sb().from('profiles').select('username,display_color,settings').eq('id', A.user.id).maybeSingle();
      if (error) throw error;
      A.profile = data || null;
      MP.playerName = (data && data.username) || (A.user.email || 'SIGNAL').split('@')[0].toUpperCase();
      return A.profile;
    } catch (e) {
      console.warn('[MP.auth] profile load failed (did you run the SQL migration?):', e.message);
      A.profile = null;
      MP.playerName = (A.user.email || 'SIGNAL').split('@')[0].toUpperCase();
      return null;
    }
  };

  A.claimUsername = async function (username) {
    try {
      const { data, error } = await sb().rpc('claim_username', { p_username: username });
      if (error) return { ok: false, error: error.message };
      if (data && data.ok) {
        A.profile = A.profile || {};
        A.profile.username = data.username;
        MP.playerName = data.username;
        return { ok: true, username: data.username };
      }
      const code = data && data.error;
      return { ok: false, error: code === 'taken' ? 'That callsign is taken. Pick another.' : code === 'too_short' ? 'Callsign must be at least 3 characters.' : 'Could not set callsign.' };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  /* ---------------- cloud settings (preferences) ---------------- */

  A.loadCloudSettings = function () {
    try {
      if (A.profile && A.profile.settings && typeof A.profile.settings === 'object' && Object.keys(A.profile.settings).length) {
        const s = A.profile.settings;
        let changed = false;
        for (const k of Object.keys(s)) {
          if (G.settings[k] !== undefined && G.settings[k] !== s[k]) { G.settings[k] = s[k]; changed = true; }
        }
        if (changed) {
          saveSettings();
          if (window.AUD && AUD.applySettings) AUD.applySettings();
          if (window.MAIN && MAIN.renderer) { MAIN.applyQuality(); MAIN.applyMotionFx(); MAIN.applyBrightness(); }
          if (window.UI && UI.syncSettingsUI) UI.syncSettingsUI();
        }
      }
    } catch (e) { console.warn('[MP.auth] settings merge failed', e); }
  };

  A._settingsT = 0;
  A.saveSettingsCloud = function () {
    if (!A.user || !A.available) return;
    clearTimeout(A._settingsT);
    A._settingsT = setTimeout(async () => {   // debounced — settings are a milestone, not a tick
      try {
        await sb().from('profiles').update({ settings: Object.assign({}, G.settings) }).eq('id', A.user.id);
      } catch (e) { /* ignore */ }
    }, 2500);
  };

  /* ---------------- cloud progression ---------------- */

  A.loadCloudProgress = async function () {
    try {
      const { data, error } = await sb().from('player_progress').select('*').eq('player_id', A.user.id).maybeSingle();
      if (error) throw error;
      A.progress = data || null;
      if (!data) return;
      // merge cloud -> local chapter-select progress (cloud wins on max)
      const local = UI.getProgress();
      let changed = false;
      const unlocked = Math.max(local.unlocked || 1, data.unlocked || 1);
      if (unlocked !== local.unlocked) { local.unlocked = unlocked; changed = true; }
      local.completed = local.completed || [];
      const completed = data.completed && typeof data.completed === 'object' ? Object.keys(data.completed).map(Number).filter(n => data.completed[n]) : [];
      for (const n of completed) if (local.completed.indexOf(n) === -1) { local.completed.push(n); changed = true; }
      local.endings = Object.assign({}, local.endings || {}, data.endings || {});
      if (changed) STORE.set('progress', local);
    } catch (e) {
      console.warn('[MP.auth] progress load failed (migration applied?):', e.message);
    }
  };

  /** Milestone save (chapter complete / ending / match stats). Debounced + atomic RPC. */
  A.saveMilestone = function (payload) {
    if (!A.user || !A.available) return Promise.resolve({ ok: false, error: 'signed out' });
    const p = Object.assign({ unlocked: null, completed: null, endings: null, stats: null }, payload || {});
    return sb().rpc('merge_progress', {
      p_player: A.user.id,
      p_unlocked: p.unlocked,
      p_completed: p.completed && Object.keys(p.completed).length ? p.completed : null,
      p_endings: p.endings && Object.keys(p.endings).length ? p.endings : null,
      p_stats: p.stats,
      p_campaign: p.campaign || null,
    }).then(({ data, error }) => (error ? { ok: false, error: error.message } : (data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || 'rejected' })))
      .catch(e => ({ ok: false, error: e.message }));
  };

  /* ---------------- lobby metadata (room discovery) ---------------- */

  A.upsertLobby = function (row) {
    if (!A.user || !A.available) return Promise.resolve();
    return sb().from('lobbies').upsert(row, { onConflict: 'code' }).then(() => {}).catch(e => console.warn('[MP.auth] lobby upsert failed:', e.message));
  };
  A.deleteLobby = function (code) {
    if (!A.user || !A.available) return Promise.resolve();
    return sb().from('lobbies').delete().eq('code', code).then(() => {}).catch(() => {});
  };
  A.listLobbies = async function () {
    if (!A.user || !A.available) return [];
    try {
      const { data, error } = await sb().from('lobbies')
        .select('code,name,campaign,player_count,max_players,is_public,status,host_id,updated_at')
        .eq('is_public', true)
        .gte('updated_at', new Date(Date.now() - 6 * 3600e3).toISOString())
        .order('updated_at', { ascending: false }).limit(30);
      if (error) throw error;
      return data || [];
    } catch (e) { console.warn('[MP.auth] lobby list failed:', e.message); return []; }
  };

  A.displayName = function () {
    return (A.profile && A.profile.username) || MP.playerName || 'SIGNAL';
  };
})();
