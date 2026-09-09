// Gameplay tuning shared with server/constants.js. Arena-specific values
// (radius, spawn ring, colors) are NOT here — they arrive from the server
// per-map via the 'init'/'roundStart' events and are applied dynamically.

export const PLAYER_RADIUS = 0.5;
export const GROUND_Y = 0;

export const GRAVITY = 20;
export const JUMP_SPEED = 8;
export const MOVE_SPEED = 5;

export const SHOVE_COOLDOWN_MS = 650;
export const PUNCH_ANIM_MS = 300;
export const CHARGED_PUNCH_ANIM_MS = 450;
export const SPECIAL_KICK_ANIM_MS = 550;

// Hold the shove input this long for a charged shove instead of a tap.
export const CHARGE_HOLD_MS = 2000;
// Mirrors server/constants.js SPECIAL_POWER_THRESHOLD — used only as the
// HUD's initial "0/3" state before the server's first specialProgress event.
export const SPECIAL_POWER_THRESHOLD = 3;

export const KNOCKBACK_DECAY = 4.5; // higher = knockback velocity dies out faster

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
export const JOYSTICK_DEADZONE_PX = 8;

export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  `${window.location.protocol}//${window.location.hostname}:3000`;
