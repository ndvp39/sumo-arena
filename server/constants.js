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
export const MOVE_SPEED = 6;

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

// Grab & throw. Reach is capped at SHOVE_RANGE (grabbing requires being at
// least as close as a shove, not "in range and hoping"), and the cooldown
// is a bit longer than a shove's since committing to a hold is a bigger
// swing than a single push.
export const GRAB_RANGE = SHOVE_RANGE;
export const GRAB_COOLDOWN_MS = 800;
// How far above the holder's own head the held player is suspended —
// GameRoom#updateHeldPlayers forces the held player's y to holder.y + this
// every tick, purely a visual "held aloft" offset with no physics of its
// own (their real position is just teleported there each tick).
export const HELD_OFFSET_Y = 2.2;
// A hold that's never thrown auto-releases (as a drop, not a throw) after
// this long, so grabbing can't be used to stall a round indefinitely.
export const HOLD_MAX_MS = 5000;
// The biggest, most dramatic knockback tier in the game — landing a grab
// and then a throw is a real two-step commitment, so the payoff needs to
// read as bigger than even the special kick.
export const THROW_FORCE = 60;
export const THROW_UP_FORCE = 16;
// Ending a hold WITHOUT a throw (timeout, or the holder getting shoved or
// eliminated) reads as "dropped", not "attacked" — a much gentler impulse
// than even a normal shove.
export const DROP_FORCE = 4;
export const DROP_UP_FORCE = 2;

// Sprint. Mirrored on the client (client/src/constants.js) purely for
// documentation/consistency — movement itself is client-authoritative, so
// the server never actually applies this multiplier to anything.
export const SPRINT_MULTIPLIER = 1.7;

export const TICK_RATE_HZ = 30;
export const ROUND_RESTART_DELAY_MS = 5000;
export const MIN_PLAYERS_TO_START = 2;

export const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xff69b4
];
