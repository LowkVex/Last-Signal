/* ============================================================
   THE LAST SIGNAL — multiplayer client: configuration
   ------------------------------------------------------------
   Public, non-secret configuration only. The publishable
   Supabase key is designed for browser use. Secret keys and
   TURN credentials NEVER appear here — they live in the game
   server's environment and are handed out at runtime.

   Game server URL resolution order:
     1. ?server=... query parameter   (dev convenience)
     2. localStorage 'tls_server_url' (dev override)
     3. window.LS_CONFIG.SERVER_URL   (edit mp/config.js)
     4. same origin                   (normal: server serves the game)
     5. http://localhost:3000         (local dev fallback)
   ============================================================ */
(function () {
  'use strict';

  window.LS_CONFIG = Object.assign({
    // ---- Supabase (public values — safe in the browser) ----
    SUPABASE_URL: 'https://nmgrpmpmhsapcbbnwver.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_Ar49zMbSu5KCu3u0T077LA_3AHDNFE3',

    // ---- game server ----
    // Leave empty ('') for same-origin (recommended: the game server also
    // serves these game files). After deploying to Render you can either
    // keep serving the game from Render (nothing to change) or set the
    // full URL here, e.g. 'https://last-signal-server.onrender.com'
    SERVER_URL: '',
  }, window.LS_CONFIG || {});

  function resolveServerUrl() {
    try {
      const q = new URLSearchParams(location.search).get('server');
      if (q) return q.replace(/\/+$/, '');
      const ls = localStorage.getItem('tls_server_url');
      if (ls) return ls.replace(/\/+$/, '');
    } catch (e) { /* ignore */ }
    if (window.LS_CONFIG.SERVER_URL) return String(window.LS_CONFIG.SERVER_URL).replace(/\/+$/, '');
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://localhost:3000';
  }

  // ---- the MP namespace (every mp/*.js module attaches to this) ----
  window.MP = window.MP || {};
  MP.serverUrl = resolveServerUrl();
  MP.online = false;        // connected to game server
  MP.inRoom = false;        // inside a room (lobby or match)
  MP.active = false;        // inside a running multiplayer MATCH
  MP.applying = false;      // gate: we are applying a server-authoritative event locally
  MP.isSimHost = false;     // this client simulates the monster AI for the room
  MP.isHost = false;        // this client is the room host
  MP.playerId = null;       // authenticated supabase user id (server-assigned, never client-chosen)
  MP.playerName = 'YOU';
  MP.roomCode = null;
  MP.campaign = 1;
  MP.slot = 0;
  MP.members = [];          // last room:state members
  MP.dev = false;           // server running in dev-guest mode
  MP.serverInfo = null;

  // tiny event emitter for UI updates
  MP._h = {};
  MP.on = function (ev, fn) { (MP._h[ev] = MP._h[ev] || []).push(fn); };
  MP.emit = function (ev, d) { (MP._h[ev] || []).forEach(f => { try { f(d); } catch (e) { console.error('MP:' + ev, e); } }); };

  console.log('%cLAST SIGNAL MULTIPLAYER', 'color:#7a9;font:bold 12px monospace', '| server:', MP.serverUrl);
})();
