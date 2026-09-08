// Touch input for mobile/tablet play. Purely additive: this module only
// ever writes into the same `keys` object and calls the same `tryShove` /
// `applyLookDelta` (yaw/pitch update) functions that the existing desktop
// keyboard/mouse path already drives every frame in main.js. Nothing here
// knows about physics, networking, or rendering.
import { JOYSTICK_MAX_RADIUS_PX, JOYSTICK_DEADZONE_PX } from './constants.js';

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

let root = null;

// Builds the DOM for the touch control zones/buttons and wires up Pointer
// Event handlers. Safe to call once per page load; main.js decides whether
// (and when) to call this, gated on isTouchDevice().
export function initTouchControls({ keys, tryShove, applyLookDelta }) {
  root = document.getElementById('touchControls');
  if (!root) return;

  const lookLayer = document.getElementById('touchLookLayer');
  const joystickBase = document.getElementById('touchJoystickBase');
  const joystickKnob = document.getElementById('touchJoystickKnob');
  const jumpBtn = document.getElementById('touchJumpBtn');
  const shoveBtn = document.getElementById('touchShoveBtn');

  // Suppress the long-press/right-click context menu on all touch zones.
  for (const el of [lookLayer, joystickBase, jumpBtn, shoveBtn]) {
    el?.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- Virtual joystick (movement) ---------------------------------------
  let joystickPointerId = null;

  function resetJoystick() {
    keys.w = false;
    keys.a = false;
    keys.s = false;
    keys.d = false;
    if (joystickKnob) joystickKnob.style.transform = 'translate(-50%, -50%)';
  }

  joystickBase?.addEventListener('pointerdown', (e) => {
    // touch-action: none (CSS) is the passive gesture suppressor, but some
    // mobile browsers still let rapid repeated taps trigger double-tap-zoom
    // on elements driven via Pointer Events + setPointerCapture unless the
    // gesture is also actively cancelled here - the standard belt-and-
    // suspenders fix every touch-control library uses.
    e.preventDefault();
    if (joystickPointerId !== null) return;
    joystickPointerId = e.pointerId;
    joystickBase.setPointerCapture(e.pointerId);
    updateJoystick(e);
  });
  joystickBase?.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joystickPointerId) return;
    updateJoystick(e);
  });
  function endJoystick(e) {
    if (e.pointerId !== joystickPointerId) return;
    joystickPointerId = null;
    resetJoystick();
  }
  joystickBase?.addEventListener('pointerup', endJoystick);
  joystickBase?.addEventListener('pointercancel', endJoystick);

  function updateJoystick(e) {
    const rect = joystickBase.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let offsetX = e.clientX - centerX;
    let offsetY = e.clientY - centerY;
    const len = Math.hypot(offsetX, offsetY);
    if (len > JOYSTICK_MAX_RADIUS_PX) {
      const scale = JOYSTICK_MAX_RADIUS_PX / len;
      offsetX *= scale;
      offsetY *= scale;
    }
    if (joystickKnob) {
      joystickKnob.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
    }

    const deadzone = JOYSTICK_DEADZONE_PX;
    // Screen Y grows downward, so dragging the knob up (offsetY < 0) means
    // forward. Verified against player.js's update(): moveForward = w - s,
    // and forward motion is what "W" already produces on desktop.
    keys.w = offsetY < -deadzone;
    keys.s = offsetY > deadzone;
    keys.a = offsetX < -deadzone;
    keys.d = offsetX > deadzone;
  }

  // --- Look-drag layer (camera yaw/pitch) ---------------------------------
  let lookPointerId = null;
  let lastLookX = 0;
  let lastLookY = 0;

  lookLayer?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (lookPointerId !== null) return;
    lookPointerId = e.pointerId;
    lookLayer.setPointerCapture(e.pointerId);
    lastLookX = e.clientX;
    lastLookY = e.clientY;
  });
  lookLayer?.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookPointerId) return;
    const dx = e.clientX - lastLookX;
    const dy = e.clientY - lastLookY;
    lastLookX = e.clientX;
    lastLookY = e.clientY;
    applyLookDelta(dx, dy);
  });
  function endLook(e) {
    if (e.pointerId !== lookPointerId) return;
    lookPointerId = null;
  }
  lookLayer?.addEventListener('pointerup', endLook);
  lookLayer?.addEventListener('pointercancel', endLook);

  // --- Jump button (held, mirrors held-Space semantics) -------------------
  jumpBtn?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    jumpBtn.setPointerCapture(e.pointerId);
    keys.space = true;
  });
  jumpBtn?.addEventListener('pointerup', () => { keys.space = false; });
  jumpBtn?.addEventListener('pointercancel', () => { keys.space = false; });
  jumpBtn?.addEventListener('pointerleave', () => { keys.space = false; });

  // --- Shove button (single tap, tryShove() has its own cooldown gate) ----
  shoveBtn?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    shoveBtn.setPointerCapture(e.pointerId);
    tryShove();
  });
}

export function showTouchControls() {
  if (root) root.style.display = 'block';
}

export function hideTouchControls() {
  if (root) root.style.display = 'none';
}
