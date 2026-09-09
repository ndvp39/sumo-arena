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

// Arm length, mirrored from client/src/avatar.js's arm geometry
// (BoxGeometry(0.18, 0.6, 0.18) swung ~horizontal) — this is how far a hand
// actually reaches past the shoulder. Reach is measured center-to-center,
// so a hit requires the pusher's own body radius + the arm's reach to span
// the gap up to the target's body radius: anything past that is genuinely
// out of arm's reach and must NOT land, even if it looks "close enough."
export const ARM_REACH = 0.6;
export const SHOVE_RANGE = PLAYER_RADIUS * 2 + ARM_REACH; // omnidirectional — no facing/cone check, see GameRoom#handleShove
export const SHOVE_FORCE = 16;
export const SHOVE_UP_FORCE = 5;
// A charged shove (2s hold, see CHARGE_HOLD_MS on the client) hits at the
// same range but lands much harder, as a payoff for the wind-up.
export const CHARGED_SHOVE_FORCE = 30;
export const CHARGED_SHOVE_UP_FORCE = 9;
export const SHOVE_COOLDOWN_MS = 650;

// Special power: land this many charged shoves (see GameRoom#handleShove)
// and the next shove input unleashes a two-legged flying kick instead — a
// bigger lunge with much bigger payoff. Slightly longer reach than a normal
// shove (it's a lunging kick, not a stationary push).
export const SPECIAL_POWER_THRESHOLD = 3;
export const SPECIAL_KICK_RANGE = SHOVE_RANGE + 0.6;
export const SPECIAL_KICK_FORCE = 46;
export const SPECIAL_KICK_UP_FORCE = 13;

export const TICK_RATE_HZ = 30;
export const ROUND_RESTART_DELAY_MS = 5000;
export const MIN_PLAYERS_TO_START = 2;

export const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xff69b4
];
