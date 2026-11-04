/* ============================================================
   THE LAST SIGNAL — game server: secure persistence
   ------------------------------------------------------------
   Milestone saving ONLY (chapter complete, ending, match stats)
   — never per-tick movement. When SUPABASE_SECRET_KEY is
   configured the SERVER writes progress for every player in the
   room through the `merge_progress` RPC (security-definer,
   service role). Without a secret key, clients fall back to
   saving their OWN row directly (RLS: player_id = auth.uid()),
   which is still safe. The secret key never leaves the server.
   ============================================================ */
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function enabled() {
  return !!(SUPABASE_URL && SECRET_KEY);
}

async function rpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SECRET_KEY,
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`rpc ${fn} failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json().catch(() => null);
}

/**
 * Record a shared milestone for every human player in the room.
 * @param {'ending'|'chapter'|'down'|'match'} kind
 */
async function saveMilestone(kind, room, info = {}, log = console.warn) {
  if (!enabled()) return { skipped: 'SUPABASE_SECRET_KEY not configured — clients save their own rows via RLS' };
  const playerIds = [...room.members.values()]
    .filter(m => !m.dev)
    .map(m => m.playerId);
  if (!playerIds.length) return { skipped: 'no persisted players' };

  const results = [];
  for (const pid of playerIds) {
    try {
      const statsDelta = { games: 0, deaths: 0, escapes: 0, chapters: 0 };
      if (kind === 'ending' && (info.ending === 'A' || info.ending === 'B' || info.ending === 'C' || info.ending === 'complete')) {
        statsDelta.escapes = 1;
        statsDelta.games = 1;
        statsDelta.chapters = 1;
      }
      if (kind === 'down' && info.player === pid) statsDelta.deaths = 1;

      const completed = (kind === 'ending' && info.ending && info.ending !== 'complete') ? [] : null;
      const body = {
        p_player: pid,
        p_unlocked: null,
        p_completed: null,
        p_endings: info.ending && info.ending !== 'complete' && kind === 'ending' ? { [info.ending]: true } : null,
        p_stats: statsDelta,
        p_campaign: room.campaign || null,
      };
      if (kind === 'ending' && info.ending === 'complete') {
        // generic chapter complete: mark chapter n completed + unlock n+1
        body.p_completed = { [String(room.campaign)]: true };
        body.p_unlocked = Math.min(8, room.campaign + 1);
      }
      if (kind === 'ending' && info.ending !== 'complete' && room.campaign === 1) {
        body.p_completed = { '1': true };
        body.p_unlocked = 2;
      }
      void completed;
      await rpc('merge_progress', body);
      results.push({ pid, ok: true });
    } catch (e) {
      results.push({ pid, ok: false, error: String(e.message || e) });
      log('[persistence] milestone save failed for', pid.slice(0, 8), e.message);
    }
  }
  return { saved: results };
}

module.exports = { enabled, saveMilestone };
