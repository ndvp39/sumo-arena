// Gameplay tuning shared with server/constants.js. Arena-specific values
// (radius, spawn ring, colors) are NOT here — they arrive from the server
// per-map via the 'init'/'roundStart' events and are applied dynamically.

export const PLAYER_RADIUS = 0.5;
export const GROUND_Y = 0;

export const GRAVITY = 20;
export const JUMP_SPEED = 9.5;
export const MOVE_SPEED = 7.5;

// Just above the server's ELIMINATION_Y (-14, see server/constants.js) so a
// falling player visually plunges into the themed liquid surface (see
// scene.js#buildArena) right around the moment they're actually eliminated.
export const VOID_SURFACE_Y = -13;
// Once eliminated, the fall stops settling just under the liquid surface
// instead of continuing forever — close enough to ELIMINATION_Y that the
// extra drop is barely noticeable, but it means the camera (which keeps
// following the local player every frame, dead or alive) actually comes to
// rest near the death effect instead of chasing the body into the void
// indefinitely, out of view.
export const DEATH_SETTLE_Y = -15;

export const SHOVE_COOLDOWN_MS = 650;
export const PUNCH_ANIM_MS = 300;
export const CHARGED_PUNCH_ANIM_MS = 450;
export const SPECIAL_KICK_ANIM_MS = 550;
// The reach-for-a-grab lunge (see avatar.js's 'grab' POWER_ANIM entry) —
// plays on every grab attempt, hit or miss, mirroring how a shove's swing
// always plays regardless of whether it connects.
export const GRAB_ANIM_MS = 380;

// Hold the shove input this long for a charged shove instead of a tap.
export const CHARGE_HOLD_MS = 2000;
// Mirrors server/constants.js SPECIAL_POWER_THRESHOLD — used only as the
// HUD's initial "0/3" state before the server's first specialProgress event.
export const SPECIAL_POWER_THRESHOLD = 3;

export const KNOCKBACK_DECAY = 4.5; // higher = knockback velocity dies out faster

// Mirrors server/constants.js SPRINT_MULTIPLIER (movement is client-
// authoritative, so this is what actually applies the speed boost).
export const SPRINT_MULTIPLIER = 1.7;
// Fraction of JOYSTICK_MAX_RADIUS_PX the knob must be pushed past before
// mobile counts it as "sprint" — mimics an analog stick's "push further to
// run" instead of needing a separate button.
export const SPRINT_JOYSTICK_THRESHOLD = 0.8;

// How fast the walk/run leg-and-arm swing cycle advances, in radians per
// second per unit of MOVE_SPEED — see avatar.js's walk-cycle. Tuned so
// normal walking speed reads as a walk and sprint speed reads as a run,
// purely from the resulting cycle frequency (faster movement = faster
// cycle) without needing a separate "is sprinting" signal into the avatar.
export const WALK_CYCLE_HZ_PER_SPEED = 0.4;

// Mirrors server/constants.js HAZARD_RADIUS — the volcano hazard's warning
// telegraph is drawn at this size purely for visual accuracy; the client
// never uses it for any hit/collision decision, that's server-authoritative.
export const HAZARD_RADIUS_VISUAL = 2.5;

export const NETWORK_SEND_HZ = 20;
export const REMOTE_LERP_FACTOR = 0.25; // per-frame-at-60fps smoothing toward latest snapshot

export const MOUSE_SENSITIVITY = 0.0022;
export const PITCH_MIN = -0.15; // radians; how far the camera can dip below eye-level
export const PITCH_MAX = 1.3;   // radians; how far it can rise toward top-down

// Touch look-drag sensitivity — roughly 2.7x MOUSE_SENSITIVITY since a touch
// drag gesture covers far fewer screen pixels than a mouse sweep. Starting
// point for feel-tuning, not derived from anything precise.
export const TOUCH_LOOK_SENSITIVITY = 0.006;
export const JOYSTICK_MAX_RADIUS_PX = 50;
export const JOYSTICK_DEADZONE_PX = 5;

export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  `${window.location.protocol}//${window.location.hostname}:3000`;
