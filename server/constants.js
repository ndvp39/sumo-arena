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
export const JUMP_SPEED = 9.5;
export const MOVE_SPEED = 7.5;

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
// same range but lands much harder, as a payoff for the wind-up — 2.5x a
// regular shove (was ~1.9x, not a clear enough gap to actually feel like a
// different move rather than a slightly-stronger version of the same one).
export const CHARGED_SHOVE_FORCE = 40;
export const CHARGED_SHOVE_UP_FORCE = 12;
export const SHOVE_COOLDOWN_MS = 650;

// Kill-feed attribution: a hit only gets credited for an elimination if it
// landed within this long beforehand — otherwise an old hit from well
// before someone wandered off the edge on their own would wrongly get
// blamed for an unrelated later fall.
export const KILL_ATTRIBUTION_MS = 4000;

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
// read as bigger than even the special kick and send the thrown player
// flying a clearly bigger distance than any other hit in the game.
export const THROW_FORCE = 85;
export const THROW_UP_FORCE = 22;
// Ending a hold WITHOUT a throw (timeout, or the holder getting shoved or
// eliminated) reads as "dropped", not "attacked" — a much gentler impulse
// than even a normal shove.
export const DROP_FORCE = 4;
export const DROP_UP_FORCE = 2;

// Sprint. Mirrored on the client (client/src/constants.js) purely for
// documentation/consistency — movement itself is client-authoritative, so
// the server never actually applies this multiplier to anything.
export const SPRINT_MULTIPLIER = 1.7;

// Momentum-based combat: a shove/kick/throw hits harder the faster the
// attacker was actually moving (including falling) the instant they threw
// it — running into a shove, or a mid-air shove/throw while still falling
// from a jump, both hit noticeably bigger. Derived server-side from real
// position deltas between move packets (see GameRoom#updateFromClient),
// never from a client-reported number, so it can't be forged by sending a
// fake velocity — only by actually covering ground that fast, which is
// already bounded by MOVE_SPEED/SPRINT_MULTIPLIER (or a real fall).
//
// Capped generously above legit sprint/fall speeds (not tightly at them)
// so a knockback-assisted burst of speed — genuinely moving fast because
// you just got shoved — still counts; the caps exist to stop a broken or
// malicious client claiming an instant teleport as "infinite speed", not
// to nickel-and-dime legitimate momentum.
export const MOMENTUM_MAX_TRACKED_SPEED = 20;      // horizontal, units/sec
export const MOMENTUM_MAX_TRACKED_FALL_SPEED = 25; // vertical (falling), units/sec
export const MOMENTUM_SPEED_BONUS_PER_UNIT = 0.05; // +5% force per unit/sec of horizontal speed
export const MOMENTUM_FALL_BONUS_PER_UNIT = 0.03;  // +3% force per unit/sec of downward speed
export const MOMENTUM_MAX_MULTIPLIER = 2.2;        // hard cap: momentum can at most ~2.2x base force

// A grab benefits too, but it has no "force" to scale — instead a fast
// attacker gets a longer effective reach, reading as a diving/lunging
// tackle rather than a bigger hit.
export const MOMENTUM_GRAB_RANGE_BONUS_PER_UNIT = 0.02;
export const MOMENTUM_GRAB_RANGE_MAX_MULTIPLIER = 1.4;

// Volcano Pit's environmental hazard (see maps.js's `hazard` field and
// GameRoom's hazard scheduling): a fireball erupts at a random point on the
// platform at a random interval, warns everyone briefly first, then hits
// like an area-effect shove. Fully server-driven — no client input is ever
// involved in triggering or timing this.
//
// Randomized rather than a fixed metronome so it can't be predicted/
// memorized and simply avoided every time; the range keeps eruptions
// frequent enough to matter without one being reliably "due" every round.
export const HAZARD_INTERVAL_MIN_MS = 9000;
export const HAZARD_INTERVAL_MAX_MS = 15000;
// How long the telegraph is visible before the eruption actually lands —
// enough real reaction time to sprint clear from just outside the blast
// radius, not so long it reads as a non-threat.
export const HAZARD_WARNING_MS = 1500;
// Bigger than SHOVE_RANGE (an area-effect eruption, not an arm's reach) but
// still small enough relative to every map's radius that standing anywhere
// else on the platform is a real, reachable dodge.
export const HAZARD_RADIUS = 2.5;
// Same order of magnitude as a charged shove (not special/throw-tier) —
// this fires automatically and can't be juked or blocked the way reading an
// opponent's charge-up can be, so it deliberately hits softer than a
// deliberately-landed hit of similar telegraph length. Meaningful knockback,
// not a guaranteed kill from mid-arena on anything but the smallest maps.
export const HAZARD_FORCE = 38;
export const HAZARD_UP_FORCE = 13;

export const TICK_RATE_HZ = 30;
export const ROUND_RESTART_DELAY_MS = 5000;
export const MIN_PLAYERS_TO_START = 2;

export const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xff69b4
];
