# THE LAST SIGNAL — Online Co-op (6 players)

This repository upgrades the single-file horror game **THE LAST SIGNAL** into a real
**6-player online co-op** experience **without replacing anything**: every chapter,
map, mechanic, monster behaviour, puzzle, UI screen and ending from the original
single-player game is still there and still fully playable offline. Single-player
is untouched — multiplayer is an additional path entered from the new
**MULTIPLAYER — CO-OP DESCENT** button on the very first main-menu screen.

```
main menu
├── NEW INVESTIGATION      (original single-player)
├── CONTINUE               (original single-player save)
├── MULTIPLAYER — CO-OP    ← new: sign in → hub → create/join room → co-op descent
├── CHAPTER SELECT / SETTINGS / CREDITS / QUIT   (original)
```

---

## 1. What is in this repository

```
LAST-SIGNAL/
├── index.html                    the whole game (original file, surgically patched —
│                                 original code paths intact; MP guards are additive)
├── package.json                  repo-root convenience scripts (install/start/test)
├── README.md                     this file
├── .gitignore                    keeps .env / node_modules out of git
├── shared/
│   └── network-events.js         ONE protocol definition shared by client + server + tests
├── mp/                           browser-side multiplayer modules (loaded after the game script)
│   ├── config.js                 server URL + Supabase project config (publishable key only)
│   ├── auth.js                   Supabase email auth, profiles, cloud progress/settings/lobbies
│   ├── net.js                    Socket.IO layer: rooms, movement, events, reconnect states
│   ├── voice.js                  WebRTC mesh voice: proximity volume, mute, signaling
│   ├── remote-players.js         teammate rigs: interpolation, animation, footsteps, name tags
│   ├── game-hooks.js             the co-op brain: intents → server → authoritative applies
│   └── ui.js                     MP menu button, auth/hub/room panels, team HUD, downed overlay
├── vendor/
│   ├── socket.io.min.js          socket.io client 4.8.4 (served locally, no CDN needed)
│   └── supabase.umd.js           supabase-js 2.x UMD (served locally, no CDN needed)
├── server/                       authoritative Node.js game server
│   ├── package.json              deps: express, socket.io, jose, dotenv (+ start script)
│   ├── .env.example              every environment variable, documented, NO secret values
│   ├── server.js                 entry point: HTTP + Socket.IO + auth middleware (PORT, 0.0.0.0)
│   ├── authentication.js         Supabase JWT validation (JWKS/ES256 + GoTrue fallback), dev-guest mode
│   ├── rooms.js                  rooms ≤ 6, codes, membership, host migration, disconnect grace, relays
│   ├── game-state.js             THE AUTHORITATIVE SIM STATE: progression graph, validator for
│   │                             every gameplay event, doors, pickups, fuses, chapters, endings,
│   │                             movement sanity, down/revive/wipe/rewind, server-owned warm-up timer
│   ├── voice-signaling.js        WebRTC signaling relay + ICE/TURN config served from env at runtime
│   ├── persistence.js            OPTIONAL server-side milestone saves (needs SUPABASE_SECRET_KEY)
│   └── test/integration.test.js  34-test live integration suite (spawns the real server)
└── supabase/
    └── migrations/20261103000000_init_multiplayer.sql
                                  profiles / player_progress / lobbies tables, RLS policies,
                                  username claiming, progress merge RPC, triggers
```

---

## 2. How it works (architecture in one page)

### Authority model — clients never decide outcomes
The server owns everything that matters:

* **rooms & membership** — 5-character codes, max 6 players, identity taken from the
  verified auth token (no impersonation, no unauthenticated joins);
* **progression** — chapters, flags, doors, keypad codes, pickups, fuses/power,
  calibration, containment, the signal core, the extraction warm-up timer and the
  ending (A/B/C computed server-side from the shared flag record);
* **downs/revives/team wipes/rewind** — a kill is only accepted when the server's
  monster snapshot puts the creature on top of the victim;
* **sanity checks** — player speed cap (anti-teleport), monster speed cap,
  interaction range, event rate limits, event ordering.

The client sends **intents** (`game:event`), the server validates and broadcasts
**applied events** (`game:applied`); every client — including the sender — mutates
its world only from applied events. Wrong keypad codes, locked doors, out-of-order
chapters, speedhacks and unauthorized kills are all rejected server-side
(all of these paths are covered by the automated test suite).

One client is the **simulation host** (normally the room host; migrated
automatically if they leave): it runs the original monster AI + horror director
against a proxy of the most threatened player and streams validated snapshots
(~10 Hz) through the server. Everyone else interpolates the creature from those
snapshots. This keeps the *exact original AI* while the server still arbitrates
every consequence (kills, inspections, skill-check routing).

### Supabase (accounts + long-term progress, never movement)
* Email/password sign-in & sign-up, session restore, sign-out — via the publishable
  key in the browser (that key is public by design; the **secret key never ships to
  the client** and is optional even on the server).
* Tables (RLS-protected, players can only touch their own rows): `profiles`
  (username/callsign, settings), `player_progress` (chapter unlocks, completions,
  endings, stats), `lobbies` (public room listing metadata).
* Only **milestones** are saved (chapter complete, ending reached, settings) —
  movement/per-tick state is never written to Supabase.
* The game server validates the Supabase **access token** (ES256 via JWKS, GoTrue
  `/token` introspection as fallback) on every Socket.IO handshake and stamps the
  Supabase user UUID as the player ID used everywhere (Supabase = Socket.IO = WebRTC).

### WebRTC proximity voice
* Full mesh (≤ 6 peers is comfortable), signaling **only** through the game server
  (`voice:hello` / `voice:peers` / `voice:signal` / `voice:peer_left`); media never
  touches Supabase or the server.
* Distance falloff + stereo pan from the in-game positions (full volume in the lobby),
  self-mute (**M**), per-player mute (**1–5**), live mic + connection status chips,
  automatic re-handshake after a network reconnect.
* STUN works out of the box; **TURN credentials live in server env vars only** and
  are handed to clients at runtime after authentication — nothing is hardcoded in
  the game files. Without TURN, players behind symmetric NATs may fail to establish
  voice (gameplay sync is unaffected — it flows over the server socket).

### Connection states
The client surfaces CONNECTING / CONNECTED / RECONNECTING / CONNECTION FAILED /
OFFLINE on every MP screen, plus human-readable errors ("Room not found",
"Room is full", "Only the host can start", …). Disconnects during a match get a
**45 s grace**: the member stays (downed, revivable), and a page refresh or
network blip re-attaches with a full authoritative snapshot.

---

## 3. Prerequisites

* **Node.js ≥ 18** (LTS recommended) — https://nodejs.org
* A **Supabase** project (free tier is fine) for accounts/cloud saves.
  The project used during development: `https://nmgrpmpmhsapcbbnwver.supabase.co`
  (its publishable key is already wired into `mp/config.js`; to use your own
  project, change `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` there and in the
  server env).
* Optional: a TURN relay (Metered/OpenRelay/coturn) for voice across strict NATs.

---

## 4. Supabase setup (one time)

1. Open your Supabase project → **SQL Editor**.
2. Paste the entire contents of
   `supabase/migrations/20261103000000_init_multiplayer.sql` and run it.
   (Or with the Supabase CLI: `supabase db push` from the repo root.)
   This creates `profiles`, `player_progress`, `lobbies`, their RLS policies,
   the `handle_new_user` trigger, `claim_username()`, `merge_progress()` and
   `touch_last_seen()` RPCs. All policies are self-only for private data.
3. **Authentication → Providers**: make sure **Email** is enabled.
   * For instant testing you may disable "Confirm email" (settings → auth);
     with confirmation ON, players must click the verification mail first —
     the client shows that state instead of an error.
4. **API keys**: copy the *publishable* key (safe for clients) into
   `mp/config.js` if you use your own project. The *secret* key is OPTIONAL and
   belongs only in the server environment (`SUPABASE_SECRET_KEY`) — with it the
   server additionally merges room milestone saves; without it each client saves
   its own row through RLS. **Never** put the secret key in the frontend or repo.

---

## 5. Run locally

```bash
cd LAST-SIGNAL/server
npm install                 # express, socket.io, jose, dotenv
cp .env.example .env        # then edit .env if needed (defaults work for dev)
npm start                   # → http://0.0.0.0:3000
```

Now open **http://localhost:3000** in your browser — the server also serves the
game itself, so client and server are same-origin and no CORS/config is needed.

> Microphone note: browsers only grant mic access on **localhost** or **https**.
> `http://localhost:3000` is fine for voice testing; `http://192.168.x.x` is not.

### Testing multiplayer locally (no Supabase needed)

For quick local testing set `AUTH_MODE=dev` in `server/.env` and restart. The auth
screen then shows a **DEV GUEST (LOCAL TEST SERVER)** button: each browser tab gets
a stable guest identity without any account. The server refuses dev guests when
`NODE_ENV=production`, so this can never weaken a deployed build.

Two-player smoke test:

1. `AUTH_MODE=dev npm start`
2. Browser A → http://localhost:3000 → MULTIPLAYER → DEV GUEST → CREATE ROOM.
3. Browser B (different profile or incognito) → MULTIPLAYER → DEV GUEST →
   enter the 5-character code → JOIN.
4. Both press READY, host presses START DESCENT. You should see each other move
   (position/rotation/animation/flashlight), hear each other with **M** mic on,
   share doors/pickups/fuses/keypad results, and get server-arbitrated downs and
   revives (hold **E** next to a downed teammate).

For 6 players, open six tabs/incognito windows and repeat (the room list also
appears in the hub; capacity is enforced at 6 — the 7th join is rejected).

### Automated tests

```bash
cd LAST-SIGNAL/server
npm test            # both suites (55 tests)
npm run test:server # 34 live socket integration tests only
npm run test:client # 21 jsdom tests against the real index.html DOM only
```

`test:server` spawns the **real server** (dev auth, short warm-up) and drives it
over actual sockets; `test:client` boots the **real client modules inside the
real page DOM** (jsdom) and exercises every UI renderer and server-event
handler. See §8 for exactly what is covered.

---

## 6. Deploy to Render

1. **Upload to GitHub**
   ```bash
   cd LAST-SIGNAL
   git init
   git add .
   git commit -m "THE LAST SIGNAL — 6-player online co-op"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   `.gitignore` already excludes `.env` and `node_modules`. The `vendor/` files
   **are** committed on purpose so the deployed server can serve the game with no
   CDN dependency. The repo root is `LAST-SIGNAL/` itself (it contains
   `package.json`, `index.html`, `server/`, …).

2. **Create the service** — Render Dashboard → **New → Web Service** →
   connect the repository.
   * **Root Directory: `server`**  ← this is the directory Render must build.
   * **Runtime:** Node
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
   * Any instance type works (the game server is lightweight; free tier is fine).
   * Render injects `PORT` automatically — the server binds `0.0.0.0:$PORT`.
   * WebSockets work out of the box on Render web services.

3. **Environment variables** (Dashboard → your service → Environment):

   | Variable | Required | Value |
   |---|---|---|
   | `SUPABASE_URL` | yes (for accounts) | `https://<project>.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | yes (for token validation) | `sb_publishable_...` |
   | `SUPABASE_SECRET_KEY` | optional | server-side only; enables server milestone saves |
   | `AUTH_MODE` | yes | `strict` in production (**never** `dev`) |
   | `CORS_ORIGIN` | optional | `*` default; tighten to your game origin if you like |
   | `STUN_URLS` | optional | comma-separated; sane Google STUN default built in |
   | `TURN_URL` | for voice across strict NATs | `turn:your.relay:3478` |
   | `TURN_USERNAME` | with TURN | relay username |
   | `TURN_CREDENTIAL` | with TURN | relay credential (never in the client repo) |
   | `GAME_SERVER_URL` | only for split hosting | public URL of this server, if the game is served from elsewhere |
   | `LIFT_WARMUP_MS` | optional | extraction warm-up length (default 30000; tests use 1200) |

4. **Deploy** → wait for "Live" → copy the URL, e.g.
   `https://last-signal-server.onrender.com`.

5. **Client configuration.** Because the server also serves `index.html`, the
   simplest setup needs **no client changes at all**: players just open your
   Render URL. If you instead host the game elsewhere (itch.io, GitHub Pages, …),
   point the client at the server in any of these ways (checked in this order):
   1. `?server=https://last-signal-server.onrender.com` query parameter,
   2. the in-game **SERVER URL** button on the multiplayer hub (stored in
      localStorage),
   3. `LS_CONFIG.SERVER_URL` in `mp/config.js`,
   4. same-origin (default when the game is served by the game server itself).
   For a split setup, set `CORS_ORIGIN` on the server to your game's origin
   (or leave `*`). Note: a non-localhost http page cannot use the mic —
   serve the client over https.

6. **Post-deploy checklist**
   * Open the game URL → MULTIPLAYER → sign in with a real Supabase account
     (the DEV GUEST button must NOT appear — it only shows when the server
     reports `AUTH_MODE=dev`).
   * Create a room from one device, join from another over the internet,
     start a descent, verify movement + voice.
   * Free-tier Render services sleep after inactivity — the first connect can
     take ~30 s to cold-start (the client shows RECONNECTING/CONNECTING states).

---

## 7. Playing co-op (controls & flow)

* **MULTIPLAYER** (main menu) → sign in / create account → hub →
  **CREATE ROOM** (pick the starting chapter 1–8, public/private) or
  **JOIN** by code / room list → room screen shows the big **room code**,
  **COPY CODE**, the 6-slot player list with HOST/SIM/READY/mic badges,
  **READY**, **START DESCENT** (host, when everyone is ready), **LEAVE ROOM**.
* In-match: original controls, plus
  * **M** — mute/unmute your microphone (mic chip bottom-left shows state),
  * **1–5** — mute/unmute individual teammates,
  * **hold E** next to a downed teammate — revive (~3 s, progress shown to both),
  * team HUD top-right: names, ACTIVE/HIDDEN/DOWN/LOST SIGNAL, mic icons,
    link latency and voice-peer count.
* Getting caught **downs** you instead of ending the run — your team can revive
  you. If everyone goes down it's a **TEAM WIPE**: the host can
  **REWIND TO CHECKPOINT (ALL PLAYERS)** or abandon the expedition.
* Chapter progress, unlocks and endings earned in co-op are saved to your
  Supabase profile (milestones only) and merged with your single-player progress.
* Host quits? The earliest-joined member is promoted automatically, adopts the
  creature simulation, and the match continues.

---

## 8. What was verified by the automated suite (`npm test`, 55/55 passing)

`npm test` (from `LAST-SIGNAL/` or `LAST-SIGNAL/server/`) runs two suites:
`test:server` (34 live integration tests) and `test:client` (21 jsdom tests).

### Server suite — 34/34, run against the real server over real sockets (dev-guest auth):

* **auth** — connections without a token rejected; bogus/stolen tokens rejected;
  dev-guest handshake returns a stable player ID; welcome/protocol info correct.
* **rooms** — creation with 5-char code; public listing; join by code; invalid
  code rejected; **capacity enforced at 6** (7th rejected with "room full");
  host-only start; not-ready blocks start; `game:start` to all with sim-host and
  slot assignment.
* **authority** — only the sim host may register world anchors; movement
  broadcast to teammates; **impossible-speed samples dropped** (anti-teleport).
* **progression (full chapter-1 chain)** — locked door refuses to open; shared
  pickup applies exactly once for everyone; keycard unlock sets the shared flag;
  unlock without the item rejected; **the server knows the keypad code** (wrong
  code broadcasts UNLOCK_FAILED, right code unlocks); chapter order + per-chapter
  prerequisites enforced (out-of-order and missing-prereq rejected); two fuses →
  `powerOn` flag + POWER broadcast; calibration/containment/core/truth validate
  proximity and ordering; med-scare gated by chapter; lever starts the
  **server-owned warm-up** (escape refused before LIFT_READY, allowed after);
  escape → **server computes the ending** from shared flags (containment ⇒ B) and
  flips the room to `ended`.
* **down/revive/wipe** — non-sim, non-self kill reports rejected; kills rejected
  while the monster is calm or far away (validated against streamed snapshots);
  valid kill → both clients see `player_downed`; revive ticks → progress →
  `player_revived`; post-revive grace prevents instant re-down; all-down →
  `team_wipe`; rewind recovers everyone.
* **resilience** — mid-match disconnect keeps the member in grace; reconnect with
  the same identity gets room state + full game snapshot; **host migration** on
  host disconnect; leaving notifies player and room; latency probe acks.
* **voice signaling** — `voice:hello` returns peers + ICE servers + TURN status;
  SDP relays to the addressed peer only; malformed payloads dropped.

### Client suite — 21/21, jsdom smoke tests against the REAL `index.html` DOM
(`server/test/client-modules.test.js`): loads the shipped page (scripts off),
stubs the game namespaces, then `eval`s the real `shared/network-events.js` +
`mp/*.js` in browser order and exercises:

* module boot + `MP.Auth.init()`/`MP.UI.init()` — **every** button/input the UI
  references exists and gets a handler wired;
* the MULTIPLAYER menu flow — missing socket.io vendor ⇒ clear network error;
  missing Supabase vendor ⇒ dev-guest path offered; all five connection states
  render on the chips; mic chip degrades honestly to `VOICE UNSUPPORTED`;
* room lobby rendering — code, 6 slots, HOST/READY/STANDBY/RECONNECTING badges,
  connected-count, phase text, host-only START, per-phase button visibility;
* team HUD, downed overlay, revive progress bar, team-wipe button re-arm and
  single-player handler restore, `M` mic keybind;
* **the full `game:applied` dispatcher** — flags, chapters, medscare, doors,
  keycard/code unlocks, failed codes (buzzer + keypad reset), shared pickups
  (mine vs theirs), fuse visuals + power, calibration, containment staging,
  core touch, server-decided ending, chapter complete, **rewind** (incl. the
  server-supplied checkpoint winning over a stale local copy), team wipe,
  player_left/unknown events;
* down/revive client handlers (approved-death gate, hidefail force-out,
  respawn at the server's coordinates) and offline intent paths
  (one-shot dedupe + re-arm, refused-death recovery).

This suite caught two real integration bugs that static checks missed: a call
to a nonexistent `UI.syncSettingsInputs` (cloud settings never reached the
settings panel) and a missing `GE.REWIND` constant (server broadcast
`{type: undefined}`, so clients silently dropped team-wipe rewinds). Both fixed.

Static checks also run clean: every inline/external script passes `node --check`,
every DOM id used by the MP UI exists in `index.html`, and every `MP.*` function
referenced by the patched game script exists in the modules.

---

## 9. Limitations & honest notes (what could NOT be tested here)

* **No browser in this environment.** The game client's *logic* is now covered by
  the jsdom suite (§8): the real DOM, the real `mp/*.js` modules, every UI
  renderer and the full server-event dispatcher. What jsdom cannot exercise is
  what only a real browser has: WebGL rendering, pointer lock, AudioContext and
  the WebRTC media path. Run the two-browser smoke test in §5 before shipping.
* **Real WebRTC audio + mic permissions** need two real browsers (localhost or
  https). Signaling is tested; the media path (getUserMedia → peer connections →
  proximity gain) must be confirmed live. Without TURN configured, voice can fail
  between players on symmetric NATs (gameplay unaffected).
* **Real Supabase email auth** was validated up to the wire (the project's JWKS
  endpoint answers ES256 keys; the server verifies those tokens), but full
  sign-up/sign-in flows against a live project with your email templates should
  be clicked through once after deploying.
* **Email confirmation**: if "Confirm email" is enabled in Supabase, sign-up
  returns a "check your email" state rather than an instant session — this is
  surfaced in the UI, not an error.
* **Sim-host trust model**: the sim host *runs* the original monster AI (that is
  the point — unchanged behaviour), so a malicious sim host could steer the
  creature. Every *consequence* (kills, progression, endings) is still validated
  by the server, and sim-host authority migrates if they leave. This is the
  standard trade-off for keeping the exact original AI in a 6-player co-op game
  without porting the whole simulation into Node.
* **Spectating/join-in-progress past chapter 1 start** works via snapshots, but a
  joiner spawns at the checkpoint ring, not mid-objective.
* **Progression saves** in co-op are milestone-based (chapter complete, ending,
  settings). The original single-player localStorage save is untouched and is
  never written during MP matches.
* The `lobbies` listing merges the server's live rooms with Supabase-listed
  lobbies; a lobby row whose server has since restarted shows as "(listed)" and
  joining it falls back to the code join error path.

---

## 10. Environment variables (complete list)

Defined in `server/.env.example` (names documented there, no secret values):

`PORT`, `HOST`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
(optional, server-only), `AUTH_MODE` (`strict` | `dev`), `CORS_ORIGIN`,
`STUN_URLS`, `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `GAME_SERVER_URL`
(client-facing hint for split hosting), `LIFT_WARMUP_MS` (optional).

Client-side config lives in `mp/config.js` (`LS_CONFIG.SERVER_URL`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`) — publishable values only; no secret
key ever appears in the frontend or this repository, and `.env` is gitignored.

---

## 11. Credits

THE LAST SIGNAL — original single-player game preserved in full.
Co-op upgrade: Supabase accounts, authoritative Socket.IO server, WebRTC
proximity voice, shared-progression horror for six survivors.
Three.js r128 (MIT) is inlined in `index.html` as in the original.
