/* ============================================================
   THE LAST SIGNAL — SHARED NETWORK PROTOCOL
   Used by BOTH the Node game server and the browser client.
   Single source of truth for every Socket.IO event name and
   the movement-flag bitfield. Do not rename events without
   updating server/ and mp/ together.
   ============================================================ */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod; // Node (server + tests)
  if (root) root.LS_NET = mod;                                              // Browser (window.LS_NET)
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 3;
  const MAX_PLAYERS = 6;

  const EV = {
    // ---- connection / auth ----
    NET_WELCOME:        'net:welcome',        // S->C  {playerId, name, serverTime, protocol}
    NET_ERROR:          'net:error',          // S->C  {message, code}

    // ---- rooms / lobby ----
    ROOM_CREATE:        'room:create',        // C->S  {isPublic, campaign, name}          ack {ok, code, room} | {ok:false, error}
    ROOM_JOIN:          'room:join',          // C->S  {code}                              ack {ok, room, snapshot?} | {ok:false, error}
    ROOM_LEAVE:         'room:leave',         // C->S  {}
    ROOM_LIST:          'room:list',          // C->S  {}                                  ack {ok, rooms}
    ROOM_SET_READY:     'room:set_ready',     // C->S  {ready}
    ROOM_SET_CAMPAIGN:  'room:set_campaign',  // C->S  {campaign}   (host, lobby only)
    ROOM_START:         'room:start',         // C->S  {}           (host, all ready)
    ROOM_STATE:         'room:state',         // S->C  {room}
    ROOM_CLOSED:        'room:closed',        // S->C  {reason}
    ROOM_KICKED:        'room:kicked',        // S->C  {reason}

    // ---- match lifecycle ----
    GAME_START:         'game:start',         // S->C  {campaign, slots, spawn, simHostId, ts}
    GAME_SNAPSHOT:      'game:snapshot',      // S->C  full authoritative state (join-in-progress / reconnect)
    GAME_EVENT:         'game:event',         // C->S  {type, ...payload, at?}             ack {ok} | {ok:false, error}
    GAME_APPLIED:       'game:applied',       // S->C  {type, by, seq, ...payload}
    WORLD_ANCHORS:      'world:anchors',      // C->S  canonical world points (sim host, once per match)

    // ---- realtime state ----
    STATE_MOVE:         'state:move',         // C->S  {p:[x,y,z], yaw, f, s, t}
    STATE_PLAYERS:      'state:players',      // S->C  {t, p:[[id,x,y,z,yaw,f,s],...]}  batched ~15Hz
    SIM_MONSTER:        'sim:monster',        // C->S  monster snapshot (sim host ~10Hz)
    STATE_MONSTER:      'state:monster',      // S->C  relay of validated monster snapshot

    // ---- simulation host role ----
    SIM_ROLE:           'sim:role',           // S->C  {isSimHost, reason}

    // ---- monster inspection / skill checks ----
    SIM_INSPECT:        'sim:inspect',        // C->S  {etype, target, diff?, second?, text?}  (sim host)
    GAME_INSPECT:       'game:inspect',       // S->C  relayed to the targeted player
    GAME_SKILL_RESULT:  'game:skill_result',  // C->S  {success}   (target player)
    SIM_SKILL_RESULT:   'sim:skill_result',   // S->C  {by, success} (relayed to sim host)

    // ---- down / revive / wipe ----
    GAME_DOWN_REQUEST:  'game:down_request',  // C->S  {target, reason}
    GAME_PLAYER_DOWNED: 'game:player_downed', // S->C  {player, reason}
    GAME_REVIVE_TICK:   'game:revive_tick',   // C->S  {target}
    GAME_REVIVE_PROGRESS: 'game:revive_progress', // S->C {by, target, progress}
    GAME_PLAYER_REVIVED: 'game:player_revived', // S->C {player, at:[x,z]}
    GAME_TEAM_WIPE:     'game:team_wipe',     // S->C  {}
    GAME_REWIND_REQUEST: 'game:rewind_request', // C->S {}
    GAME_REWIND:        'game:rewind',        // S->C  {}

    // ---- voice (WebRTC signaling; media NEVER touches the server) ----
    VOICE_HELLO:        'voice:hello',        // C->S  {mic}
    VOICE_PEERS:        'voice:peers',        // S->C  {peers:[{id,name,mic}]}
    VOICE_SIGNAL:       'voice:signal',       // C<->S {to?, from?, data}  (SDP / ICE relay)
    VOICE_STATE:        'voice:state',        // C->S / S->C  {mic:'on'|'off'|'muted', id?}
    VOICE_PEER_LEFT:    'voice:peer_left',    // S->C  {id}
    VOICE_ICE_REQUEST:  'voice:ice_request',  // C->S  ack {ok, iceServers}
  };

  // ---- movement flag bits (state:move "f" field) ----
  const F = {
    CROUCH:  1,
    SPRINT:  2,
    HIDDEN:  4,
    DOWNED:  8,
    FLASH:   16,
    MIC:     32,
    MUTED:   64,
    MOVING:  128,
  };

  // ---- game event types carried by GAME_EVENT / GAME_APPLIED ----
  const GE = {
    FLAG:            'flag',             // {name}
    CHAPTER:         'chapter',          // {n}
    DOOR:            'door',             // {key, open}
    UNLOCK:          'unlock',           // {key, method:'keycard'|'code'|'power', code?}
    UNLOCK_FAILED:   'unlock_failed',    // {key}
    PICKUP:          'pickup',           // {id}
    FUSE:            'fuse',             // {slot}
    POWER:           'power',             // {bus, on}
    CHECKPOINT:      'checkpoint',       // {gx, gy, yaw}
    MEDSCARE:        'medscare',
    LEVER:           'lever',
    LIFT_READY:      'lift_ready',
    CALIBRATED:      'calibrated',
    CONTAINMENT:     'containment',
    CORE_TOUCHED:    'core_touched',
    ESCAPE:          'escape',
    ENDING:          'ending',           // {id}  (server-decided)
    CHAPTER_COMPLETE: 'chapter_complete', // {n}
    TRUTH_READ:      'truth_read',
    REWIND:          'rewind',           // {checkpoint:{gx,gy,yaw}} — team-wipe recovery
  };

  // ---- connection states surfaced in the client UI ----
  const CONN = {
    OFFLINE:      'offline',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    RECONNECTING: 'reconnecting',
    FAILED:       'failed',
  };

  const ROOM_PHASE = { LOBBY: 'lobby', PLAYING: 'playing', ENDED: 'ended' };

  const ERR = {
    NOT_AUTHENTICATED: 'not_authenticated',
    BAD_TOKEN:         'bad_token',
    ROOM_NOT_FOUND:    'room_not_found',
    ROOM_FULL:         'room_full',
    ALREADY_IN_ROOM:   'already_in_room',
    NOT_HOST:          'not_host',
    NOT_READY:         'not_ready',
    BAD_REQUEST:       'bad_request',
    RATE_LIMITED:      'rate_limited',
    REJECTED:          'rejected',
    GAME_LOCKED:       'game_locked',
    IN_GAME:           'in_game',
  };

  return { PROTOCOL_VERSION, MAX_PLAYERS, EV, F, GE, CONN, ROOM_PHASE, ERR };
});
