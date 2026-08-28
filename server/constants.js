// Shared gameplay tuning values. Mirrored on the client in client/src/constants.js
// (kept in two files because client/server are separate npm packages).

// Note: arena radius / spawn radius are per-map values now (see maps.js),
// not global constants — everything below applies to every map equally.

export const PLAYER_RADIUS = 0.5;
export const GROUND_Y = 0;
// Deliberately deep: the client only clamps to ground while over the
// platform (see player.js), so once someone walks/gets knocked off the
// edge they fall freely under gravity. This threshold gives that a real,
// visible ~1.2s fall into the void before the round actually counts them out.
export const ELIMINATION_Y = -14;

export const GRAVITY = 20;
export const JUMP_SPEED = 8;
export const MOVE_SPEED = 5;

// Generous on purpose: reach is measured center-to-center (players are
// PLAYER_RADIUS=0.5 each, arms visually extend further), and the pusher's
// own server-side position can lag their true position by up to one
// network tick (~50ms at 20Hz) at the moment they press F. A tight range
// made shoves that looked like a clean hit silently fail.
export const SHOVE_RANGE = 2.6; // omnidirectional — no facing/cone check, see GameRoom#handleShove
export const SHOVE_FORCE = 11;
export const SHOVE_UP_FORCE = 3.5;
export const SHOVE_COOLDOWN_MS = 650;

export const TICK_RATE_HZ = 30;
export const ROUND_RESTART_DELAY_MS = 5000;
export const MIN_PLAYERS_TO_START = 2;

export const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xff69b4
];
