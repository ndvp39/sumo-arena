import { SceneManager } from './scene.js';
import { LocalPlayer } from './player.js';
import { RemotePlayers } from './remotePlayers.js';
import { Network } from './network.js';
import {
  SHOVE_COOLDOWN_MS, NETWORK_SEND_HZ, MOUSE_SENSITIVITY, PITCH_MIN, PITCH_MAX,
  TOUCH_LOOK_SENSITIVITY, CHARGE_HOLD_MS, SPECIAL_POWER_THRESHOLD
} from './constants.js';
import { isTouchDevice, initTouchControls, showTouchControls, setShoveChargeProgress, setSpecialReady } from './touchControls.js';

const loginOverlay = document.getElementById('loginOverlay');
const nameInput = document.getElementById('nameInput');
const playBtn = document.getElementById('playBtn');
const hud = document.getElementById('hud');
const controlsHint = document.getElementById('controlsHint');
const mapNameEl = document.getElementById('mapName');
const aliveCountEl = document.getElementById('aliveCount');
const banner = document.getElementById('banner');
const mouseLookHint = document.getElementById('mouseLookHint');
const specialMeterEl = document.getElementById('specialMeter');
const specialPipEls = specialMeterEl ? [...specialMeterEl.querySelectorAll('.pip')] : [];
const specialHintEl = document.getElementById('specialHint');
const desktopChargeRing = document.getElementById('desktopChargeRing');
const desktopChargeFill = document.getElementById('desktopChargeFill');
const debugOverlay = document.getElementById('debugOverlay');

let canvas;
let sceneManager, localPlayer, remotePlayers, network;
let selfId = null;
let selfColor = null; // this player's server-assigned color, used to tint their own death-effect debris
let controlsEnabled = false;
let lastShoveClientTime = 0;

// Shove hold-to-charge state, shared by the desktop F key and the mobile
// shove button (see onShovePress/onShoveRelease). chargeStartTime is the
// performance.now() the current charge cycle began, or null when idle.
let fShoveHeld = false;
let chargeStartTime = null;

// Special-power combo, mirrored from the server's authoritative count via
// the 'specialProgress' event — this is display-only, never gates anything
// server-side doesn't already gate (see GameRoom#handleShove).
let specialReady = false;

const keys = { w: false, a: false, s: false, d: false, space: false };

// Last-resort, page-wide zoom guards. CSS touch-action and the per-control
// preventDefault() calls in touchControls.js should already stop zoom, but
// some mobile browsers still let it through regardless - these two catch it
// unconditionally, everywhere on the page (not just the touch control
// zones), and are no-ops on desktop since neither event fires there:
// - a document-wide double-tap debounce (cancels any touchend landing
//   within 350ms of the previous one, the classic cross-browser fix)
// - iOS Safari's proprietary pinch-zoom gesture events, which fire
//   independently of touch-action/Pointer Events on some iOS versions.
let lastTouchEndAt = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEndAt < 350) e.preventDefault();
  lastTouchEndAt = now;
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

// Mouse-look camera orbit state, driven by Pointer Lock (see setupInput).
// yaw/pitch are independent of the avatar's own transform — the avatar's
// facing is derived FROM cameraYaw each frame in player.js, not vice versa.
let cameraYaw = 0;
let cameraPitch = 0.25;

let restartCountdownTimer = null;

// Last transform we told the server about — used to isolate genuine
// server-side corrections (collision push-apart) from ordinary network
// latency when the state broadcast echoes our own position back to us.
let lastSentX = 0;
let lastSentZ = 0;

// Paints whichever charge indicator applies — the desktop ring and the
// mobile shove-button fill (touchControls.js#setShoveChargeProgress) are
// updated unconditionally, not gated on isTouchDevice(). That check is only
// used at setup time to decide which *container* is visible/interactive
// (#touchControls vs the keyboard/mouse hints) — deciding which UI to PAINT
// here as well used to double as an implicit "is this really a touch
// device" gate, and `pointer: coarse` is a known-unreliable signal on
// hybrid/touchscreen laptops (it can read coarse even with a keyboard and
// mouse actively in use), which silently sent every update to the hidden
// mobile button instead of the visible desktop ring. Updating both is
// harmless either way: whichever container CSS actually hides stays
// invisible regardless of what its fill color is set to.
function updateChargeUI(progress) {
  setShoveChargeProgress(progress);
  if (!desktopChargeRing) return;
  if (progress > 0) {
    desktopChargeRing.style.display = 'block';
    desktopChargeFill.style.background = `conic-gradient(#ffcc33 ${progress * 360}deg, transparent 0)`;
  } else {
    desktopChargeRing.style.display = 'none';
  }
}

// Single source of truth for the special-power meter: the 3 pips, the hint
// text (device-aware — "press Q" vs "tap"), and the ready-state glow. Also
// flips the mobile special button between dim/inert and glowing/tappable.
function updateSpecialUI(count, threshold, ready) {
  specialReady = ready;
  specialPipEls.forEach((pip, i) => pip.classList.toggle('filled', i < count));
  specialMeterEl?.classList.toggle('ready', ready);
  if (specialHintEl) {
    if (ready) {
      specialHintEl.textContent = isTouchDevice() ? 'SPECIAL READY — tap the kick button!' : 'SPECIAL READY — press Q!';
    } else {
      const remaining = threshold - count;
      specialHintEl.textContent = `Land ${remaining} more charged shove${remaining === 1 ? '' : 's'}`;
    }
  }
  setSpecialReady(ready);
}

function showBanner(text, sub = '') {
  banner.textContent = '';
  const line = document.createElement('div');
  line.textContent = text;
  banner.appendChild(line);
  if (sub) {
    const subLine = document.createElement('div');
    subLine.className = 'sub';
    subLine.textContent = sub;
    banner.appendChild(subLine);
  }
  banner.style.display = 'block';
}
function hideBanner() {
  banner.style.display = 'none';
}
function clearRestartCountdown() {
  if (restartCountdownTimer) {
    clearInterval(restartCountdownTimer);
    restartCountdownTimer = null;
  }
}
// Counts down to the server's known restart time so everyone can see when
// the rest of the players will be back in a fresh round, instead of just
// "starting soon" with no indication of how long that actually is.
function startRestartCountdown(titleText, restartInMs) {
  clearRestartCountdown();
  let secondsLeft = Math.max(0, Math.ceil(restartInMs / 1000));
  showBanner(titleText, `Next round in ${secondsLeft}s`);
  restartCountdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      showBanner(titleText, 'Starting...');
      clearRestartCountdown();
    } else {
      showBanner(titleText, `Next round in ${secondsLeft}s`);
    }
  }, 1000);
}

function startGame(name) {
  loginOverlay.style.display = 'none';
  hud.style.display = 'block';
  // Desktop shows the keyboard/mouse control hint; touch devices get their
  // own self-explanatory on-screen buttons instead (see setupInput below),
  // so the desktop-only hint text would be misleading there.
  if (!isTouchDevice()) {
    controlsHint.style.display = 'block';
    if (mouseLookHint) mouseLookHint.style.display = 'block';
  }
  if (specialMeterEl) specialMeterEl.style.display = 'block';
  updateSpecialUI(0, SPECIAL_POWER_THRESHOLD, false);

  canvas = document.createElement('canvas');
  document.getElementById('app').prepend(canvas);

  sceneManager = new SceneManager(canvas);
  remotePlayers = new RemotePlayers(sceneManager.scene, (pos, color) => sceneManager.spawnDeathEffect(pos, color));
  network = new Network();

  network.connect(name, {
    onInit: (data) => {
      selfId = data.selfId;
      sceneManager.buildArena(data.map);
      mapNameEl.textContent = `Map: ${data.map.name}`;

      const self = data.players.find(p => p.id === selfId);
      selfColor = self.color;
      localPlayer = new LocalPlayer(name, self.color, sceneManager.scene);
      localPlayer.setArenaRadius(data.map.radius);
      localPlayer.respawn(self.x, self.z, self.rotY);
      lastSentX = self.x;
      lastSentZ = self.z;
      cameraYaw = self.rotY;

      remotePlayers.removeAll();
      for (const p of data.players) {
        if (p.id !== selfId) remotePlayers.add(p);
      }

      controlsEnabled = true;
    },
    onPlayerJoined: (p) => remotePlayers.add(p),
    onPlayerLeft: (id) => remotePlayers.remove(id),
    onState: (players) => {
      remotePlayers.updateFromState(players, selfId);
      const alive = players.filter(p => p.alive).length;
      aliveCountEl.textContent = `Players alive: ${alive}/${players.length}`;

      const self = players.find(p => p.id === selfId);
      if (self && localPlayer) {
        localPlayer.applyServerCorrection(self.x, self.z, lastSentX, lastSentZ);
      }
    },
    onShoveAction: ({ playerId, power }) => {
      if (playerId === selfId) localPlayer?.playPunch(power);
      else remotePlayers.playPunch(playerId, power);

      if (power && power !== 'normal') {
        const pos = playerId === selfId ? localPlayer?.avatar.group.position : remotePlayers.getPosition(playerId);
        if (pos) {
          sceneManager.spawnShockwave(pos, power === 'special'
            ? { color: 0x66e0ff, scaleMult: 1.7, duration: 0.6 }
            : { color: 0xffcc33, scaleMult: 1, duration: 0.45 });
        }
      }
    },
    onShoveHit: (data) => {
      if (data.targetId === selfId && localPlayer) {
        localPlayer.applyKnockback(data.dirX, data.dirZ, data.force, data.upForce);
        if (data.power === 'charged') sceneManager.shake(0.25, 250);
        else if (data.power === 'special') sceneManager.shake(0.45, 400);
      }
    },
    onSpecialProgress: ({ count, threshold, ready }) => updateSpecialUI(count, threshold, ready),
    onEliminated: (id) => {
      if (id === selfId) {
        sceneManager.spawnDeathEffect(localPlayer.avatar.group.position, selfColor);
        localPlayer.setAlive(false);
        controlsEnabled = false;
        showBanner('You were eliminated', 'Spectating — next round starts soon');
      }
    },
    onRoundOver: (data) => {
      controlsEnabled = false;
      const titleText = data.winnerId === selfId
        ? 'You win!'
        : data.winnerName ? `${data.winnerName} wins!` : 'Round over';
      startRestartCountdown(titleText, data.restartInMs ?? 5000);
    },
    onRoundStart: (data) => {
      clearRestartCountdown();
      hideBanner();
      sceneManager.buildArena(data.map);
      mapNameEl.textContent = `Map: ${data.map.name}`;

      const self = data.players.find(p => p.id === selfId);
      if (self && localPlayer) {
        localPlayer.setArenaRadius(data.map.radius);
        localPlayer.respawn(self.x, self.z, self.rotY);
        lastSentX = self.x;
        lastSentZ = self.z;
      }
      cameraYaw = self ? self.rotY : cameraYaw;
      remotePlayers.respawnAll(data.players, selfId);
      controlsEnabled = true;
    },
    onDisconnect: () => {
      controlsEnabled = false;
      clearRestartCountdown();
      showBanner('Disconnected', 'Trying to reconnect...');
    }
  });

  setupInput();
  requestAnimationFrame(loop);
}

function setupInput() {
  // All keys are independent booleans, so holding several at once (W+D
  // diagonal, W+Space, W+F, ...) just works — nothing here treats inputs
  // as mutually exclusive.
  // Arrow keys are plain aliases for WASD (same booleans, so W+ArrowRight
  // held together just behaves like W+D — nothing treats them separately).
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = true; break;
      case 'KeyA': case 'ArrowLeft': keys.a = true; break;
      case 'KeyS': case 'ArrowDown': keys.s = true; break;
      case 'KeyD': case 'ArrowRight': keys.d = true; break;
      case 'Space': keys.space = true; e.preventDefault(); break;
      case 'KeyF': if (!e.repeat) onShovePress(); break;
      case 'KeyQ': if (!e.repeat) fireSpecial(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = false; break;
      case 'KeyA': case 'ArrowLeft': keys.a = false; break;
      case 'KeyS': case 'ArrowDown': keys.s = false; break;
      case 'KeyD': case 'ArrowRight': keys.d = false; break;
      case 'Space': keys.space = false; break;
      case 'KeyF': onShoveRelease(); break;
    }
  });

  if (isTouchDevice()) {
    // Pointer Lock isn't usable on touch (notably unsupported on iOS
    // Safari), so skip the click-to-lock/mousemove wiring entirely rather
    // than relying on it to silently no-op. Touch input drives the same
    // keys/cameraYaw/cameraPitch/shove state machine through initTouchControls.
    initTouchControls({
      keys,
      onShovePress,
      onShoveRelease,
      onSpecialTrigger: fireSpecial,
      applyLookDelta: (dx, dy) => applyMouseLookDelta(dx, dy, TOUCH_LOOK_SENSITIVITY)
    });
    showTouchControls();
    return;
  }

  // Mouse-look via the Pointer Lock API: the first click just locks the
  // cursor (a browser requirement — requestPointerLock must run inside a
  // user-gesture handler); once locked, the same buttons double as the F/Q
  // aliases below. Raw mouse movement then drives camera yaw/pitch until
  // Escape (or an unlock event) releases it again.
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
      return;
    }
    if (e.button === 0) onShovePress();       // left click == F (hold to charge)
    else if (e.button === 2) fireSpecial();   // right click == Q (special kick)
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0) onShoveRelease();
  });
  // Right-click is a real game action here, not a context-menu trigger.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (mouseLookHint) mouseLookHint.style.display = locked ? 'none' : 'block';
    // Escape (or any other pointer-lock loss) can happen mid-hold with no
    // guaranteed mouseup to follow — release explicitly so a charge never
    // gets stuck mid-bar.
    if (!locked) onShoveRelease();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    applyMouseLookDelta(e.movementX, e.movementY, MOUSE_SENSITIVITY);
  });
}

// Shared yaw/pitch update math for both the Pointer-Lock mouse path and the
// touch look-drag layer, so the clamping logic isn't duplicated. dx/dy are
// incremental screen-pixel deltas (movementX/Y for mouse, or a manually
// tracked last-point delta for touch); sensitivity is the only thing that
// differs between the two input sources.
function applyMouseLookDelta(dx, dy, sensitivity) {
  cameraYaw -= dx * sensitivity;
  cameraPitch += dy * sensitivity; // inverted: drag/mouse-up looks the way down used to
  cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch));
}

// Sends a shove if the cooldown allows it. Returns whether it actually
// fired, so callers (the charge loop especially) know whether to advance
// their own state or keep waiting.
function fireShove(power) {
  if (!controlsEnabled || !localPlayer?.alive) return false;
  const now = performance.now();
  if (now - lastShoveClientTime < SHOVE_COOLDOWN_MS) return false;
  lastShoveClientTime = now;
  network.sendShove(power);
  return true;
}

// Press: start charging (unless already on cooldown, in which case this
// hold does nothing — matches a tap's existing silent-no-op-on-cooldown
// behavior). The loop() below advances the charge and auto-fires a
// 'charged' shove once CHARGE_HOLD_MS is reached.
function onShovePress() {
  if (fShoveHeld) return;
  fShoveHeld = true;
  if (!controlsEnabled || !localPlayer?.alive) return;
  if (performance.now() - lastShoveClientTime < SHOVE_COOLDOWN_MS) return;
  chargeStartTime = performance.now();
}

// Release: a quick tap (released before the charge threshold) fires a
// normal shove. A hold that already reached the threshold fired its
// 'charged' shove inside loop() already, so there's nothing left to do here
// but clear the charge state/UI.
function onShoveRelease() {
  if (!fShoveHeld) return;
  fShoveHeld = false;
  if (chargeStartTime !== null && performance.now() - chargeStartTime < CHARGE_HOLD_MS) {
    fireShove('normal');
  }
  chargeStartTime = null;
  updateChargeUI(0);
}

function fireSpecial() {
  if (!specialReady) return;
  fireShove('special');
}

let lastTime = performance.now();
let sendAccumulator = 0;
const sendInterval = 1 / NETWORK_SEND_HZ;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (localPlayer) {
    localPlayer.update(controlsEnabled ? keys : { w: false, a: false, s: false, d: false, space: false }, dt, cameraYaw);
    sceneManager.updateCamera(localPlayer.position, cameraYaw, cameraPitch, dt);

    sendAccumulator += dt;
    if (sendAccumulator >= sendInterval) {
      sendAccumulator = 0;
      // Only stream position while alive. The server already ignores move
      // updates from a dead player (GameRoom.updateFromClient), but there's
      // a race: this client keeps free-falling its own view for the
      // dramatic drop the whole time it's dead/spectating (which can be
      // several seconds, arbitrarily far below the map), and a packet sent
      // during that fall can still be in flight when the round restarts and
      // the server flips this player back to alive - at which point that
      // stale packet would be accepted, snapping the freshly-spawned player
      // back into "still falling" territory and instantly re-eliminating
      // them, restarting the round again. Never sending while dead means no
      // such stale packet can ever be in flight to race against a respawn.
      if (localPlayer.alive) {
        network.sendMove({
          x: localPlayer.position.x,
          y: localPlayer.position.y,
          z: localPlayer.position.z,
          rotY: localPlayer.rotY
        });
        lastSentX = localPlayer.position.x;
        lastSentZ = localPlayer.position.z;
      }
    }
  }

  // Advance the shove charge while held. Reaching CHARGE_HOLD_MS auto-fires
  // a 'charged' shove and immediately starts the next cycle (so holding
  // straight through keeps charging repeatedly); if the fire attempt is
  // blocked by cooldown, the bar just holds at full until it clears.
  if (fShoveHeld && chargeStartTime !== null) {
    if (!controlsEnabled || !localPlayer?.alive) {
      chargeStartTime = null;
      updateChargeUI(0);
    } else {
      const elapsed = now - chargeStartTime;
      updateChargeUI(Math.min(1, elapsed / CHARGE_HOLD_MS));
      if (elapsed >= CHARGE_HOLD_MS && fireShove('charged')) {
        chargeStartTime = now;
      }
    }
  }

  remotePlayers?.tick(dt);
  sceneManager?.updateEffects(dt);
  sceneManager?.render();

  // Read-only debug hook (harmless, no gameplay effect) so external tooling
  // can inspect ground-truth camera/player state instead of guessing it.
  window.__debug = {
    cameraYaw, cameraPitch, position: localPlayer?.position, alive: localPlayer?.alive,
    controlsEnabled, fShoveHeld, chargeStartTime, specialReady,
    hasDesktopChargeRing: !!desktopChargeRing, isTouchDevice: isTouchDevice()
  };

  // Temporary on-screen mirror of the above, so this can be read directly
  // off the screen (or a screenshot) without opening dev tools at all.
  if (debugOverlay) {
    const chargeMs = chargeStartTime !== null ? Math.round(now - chargeStartTime) : null;
    debugOverlay.textContent =
      `controlsEnabled: ${controlsEnabled}\n` +
      `alive: ${localPlayer?.alive}\n` +
      `fShoveHeld: ${fShoveHeld}\n` +
      `chargeStartTime: ${chargeStartTime !== null ? 'set' : 'null'}\n` +
      `chargeMs: ${chargeMs}\n` +
      `isTouchDevice: ${isTouchDevice()}\n` +
      `hasDesktopChargeRing: ${!!desktopChargeRing}\n` +
      `ringDisplay: ${desktopChargeRing ? desktopChargeRing.style.display || '(css default)' : 'n/a'}`;
  }
}

// Phones reserve on-screen space for the browser's address bar unless the
// page enters fullscreen; since this page never scrolls, the bar never gets
// the scroll gesture that would normally let it auto-collapse. Requesting
// fullscreen here (a real user gesture, required by the API) reclaims that
// space. Silently no-ops if unsupported/denied — never blocks play.
function requestFullscreenSafe() {
  const el = document.documentElement;
  const request = el.requestFullscreen?.bind(el) || el.webkitRequestFullscreen?.bind(el);
  const result = request?.();
  result?.catch?.(() => {});
}

playBtn.addEventListener('click', () => {
  const name = nameInput.value.trim() || `Player${Math.floor(Math.random() * 1000)}`;
  if (isTouchDevice()) requestFullscreenSafe();
  startGame(name);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playBtn.click();
});
