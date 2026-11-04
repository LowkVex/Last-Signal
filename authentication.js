/* ============================================================
   THE LAST SIGNAL — game server: Supabase authentication
   ------------------------------------------------------------
   Validates the Supabase access token a client presents in the
   Socket.IO handshake BEFORE the socket is admitted.

   Strategy (in order):
     1. JWT verification against the project's published JWKS
        (${SUPABASE_URL}/auth/v1/.well-known/jwks.json) using
        `jose`. Modern Supabase projects sign user JWTs with
        asymmetric keys (ES256) — this needs NO secret on the
        game server at all.
     2. Fallback: call GoTrue `GET /auth/v1/user` with the
        user's access token. GoTrue rejects anything invalid.
        (Covers projects still on legacy HS256 JWT secrets.)
     3. DEV ONLY (AUTH_MODE=dev): accept `dev-guest:<uuid>`
        tokens so multiplayer can be tested locally without
        Supabase. Never enable this in production — the server
        refuses dev mode when NODE_ENV=production.

   The authenticated Supabase user id (uuid) becomes the ONE
   player id used across Socket.IO rooms, gameplay and WebRTC
   signaling. Clients cannot pick or spoof it.
   ============================================================ */
'use strict';

const { createRemoteJWKSet, jwtVerify } = require('jose');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const AUTH_MODE = (process.env.AUTH_MODE || 'strict').toLowerCase();
const DEV_GUESTS_ALLOWED = AUTH_MODE === 'dev' && process.env.NODE_ENV !== 'production';

let jwks = null;
function getJwks() {
  if (!jwks && SUPABASE_URL) {
    jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
  }
  return jwks;
}

/** Verify a Supabase access token via the project JWKS. */
async function verifyWithJwks(token) {
  const ks = getJwks();
  if (!ks) return null;
  try {
    const { payload } = await jwtVerify(token, ks, {
      issuer: [`${SUPABASE_URL}/auth/v1`, SUPABASE_URL],
      audience: 'authenticated',
      clockTolerance: 30,
    });
    if (!payload.sub) return null;
    return {
      id: String(payload.sub),
      email: payload.email || null,
      role: payload.role || 'authenticated',
      exp: payload.exp ? payload.exp * 1000 : Date.now() + 3600e3,
      method: 'jwks',
    };
  } catch (err) {
    return null; // fall through to GoTrue probe
  }
}

/** Fallback: ask GoTrue itself who this token belongs to. */
async function verifyWithGoTrue(token) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || !u.id) return null;
    return {
      id: String(u.id),
      email: u.email || null,
      role: u.role || 'authenticated',
      exp: Date.now() + 30 * 60 * 1000,
      method: 'gotrue',
    };
  } catch (err) {
    return null;
  }
}

/** Fetch the player's profile row (username) using THEIR OWN token, via PostgREST + RLS. */
async function fetchProfileName(playerId, token) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(playerId)}&select=username&display_color`,
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0] && rows[0].username) return rows[0];
    return null;
  } catch (err) {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticate a Socket.IO handshake.
 * Returns { id, email, name, dev } on success or throws Error with .code.
 */
async function authenticateHandshake(auth = {}) {
  const token = typeof auth.token === 'string' ? auth.token.trim() : '';
  if (!token) {
    const e = new Error('Missing authentication token. Sign in first.');
    e.code = 'not_authenticated';
    throw e;
  }

  // --- dev guest mode (local testing without Supabase) ---
  if (token.startsWith('dev-guest:')) {
    if (!DEV_GUESTS_ALLOWED) {
      const e = new Error('Guest connections are not accepted by this server.');
      e.code = 'bad_token';
      throw e;
    }
    const gid = token.slice('dev-guest:'.length);
    if (!UUID_RE.test(gid)) {
      const e = new Error('Malformed guest identity.');
      e.code = 'bad_token';
      throw e;
    }
    return {
      id: gid,
      email: null,
      name: sanitizeName(auth.name) || `GUEST-${gid.slice(0, 4).toUpperCase()}`,
      dev: true,
      exp: Date.now() + 24 * 3600e3,
    };
  }

  // --- real Supabase tokens ---
  if (!SUPABASE_URL) {
    const e = new Error('Server has no SUPABASE_URL configured; cannot validate tokens.');
    e.code = 'server_misconfigured';
    throw e;
  }

  let player = await verifyWithJwks(token);
  if (!player) player = await verifyWithGoTrue(token);
  if (!player) {
    const e = new Error('Session invalid or expired. Please sign in again.');
    e.code = 'bad_token';
    throw e;
  }

  // Display name: prefer the verified profile row (RLS-read with the user's own
  // token). Fall back to the client-provided name (display only — identity is
  // always the token's subject, never anything the client claims).
  let name = null;
  const profile = await fetchProfileName(player.id, token);
  if (profile) name = profile.username;
  if (!name) name = sanitizeName(auth.name) || (player.email ? player.email.split('@')[0] : 'SIGNAL');
  if (profile && profile.display_color) player.color = Number(profile.display_color) || 0;

  return { id: player.id, email: player.email, name: name.slice(0, 24), dev: false, exp: player.exp, token };
}

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  // strip control chars / markup, clamp length
  return n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
}

module.exports = {
  authenticateHandshake,
  fetchProfileName,
  sanitizeName,
  info: {
    supabaseUrl: SUPABASE_URL || '(not set)',
    devGuestsAllowed: DEV_GUESTS_ALLOWED,
    hasPublishableKey: !!SUPABASE_PUBLISHABLE_KEY,
  },
};
