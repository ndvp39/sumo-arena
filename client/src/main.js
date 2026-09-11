import { SceneManager } from './scene.js';
import { LocalPlayer } from './player.js';
import { RemotePlayers } from './remotePlayers.js';
import { Network } from './network.js';
import {
  SHOVE_COOLDOWN_MS, NETWORK_SEND_HZ, MOUSE_SENSITIVITY, PITCH_MIN, PITCH_MAX,
  TOUCH_LOOK_SENSITIVITY, CHARGE_HOLD_MS, SPECIAL_POWER_THRESHOLD
} from './constants.js';
import { isTouchDevice, initTouchControls, showTouchControls, setShoveChargeProgress, setSpecialReady } from './touchControls.js';
import { initAudio, playShove, playEliminate, playGrab, playSpecialReady, playRoundWin } from './audio.js';

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
const howToPlayEl = document.getElementById('howToPlay');
const killFeedEl = document.getElementById('killFeed');

// The one place the full control list lives — in-game hints (#controlsHint,
// touch button labels) stay bare key names on the assumption this was seen
// once before pressing PLAY. Device-aware since a touch player doesn't have
// a Shift key or a mouse to read about.
const DESKTOP_CONTROLS = [
  ['WASD / ←↑↓→', 'Move'],
  ['SHIFT', 'Sprint'],
  ['SPACE', 'Jump'],
  ['F / click', 'Shove (hold = charge)'],
  ['Q / right-click', 'Special (after 3 charged hits)'],
  ['E', 'Grab & carry (shove = throw)'],
  ['MOUSE', 'Look around']
];
const TOUCH_CONTROLS = [
  ['Joystick', 'Move (push far = run)'],
  ['Drag screen', 'Look around'],
  ['JUMP', 'Jump'],
  ['SHOVE', 'Shove (hold = charge)'],
  ['KICK', 'Special (glows when ready)'],
  ['GRAB', 'Grab & carry (SHOVE = throw)']
];
function renderHowToPlay() {
  if (!howToPlayEl) return;
  const rows = isTouchDevice() ? TOUCH_CONTROLS : DESKTOP_CONTROLS;
  howToPlayEl.innerHTML = rows
    .map(([key, action]) => `<span class="key">${key}</span><span class="action">${action}</span>`)
    .join('');
}
renderHowToPlay();
// Drives the compact HUD/special-meter CSS overrides (see index.html's
// `body.touch-ui` rules) — mobile's own browser chrome already eats real
// vertical space at the top of the viewport, so the top-anchored overlays
// need to be tighter there than they are on desktop.
if (isTouchDevice()) document.body.classList.add('touch-ui');

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

const keys = { w: false, a: false, s: false, d: false, space: false, sprint: false };

// Hit-stop: a brief near-freeze on impact (classic fighting-game "juice") —
// see loop()'s dt-scaling and triggerHitStop below. Bigger hits pause
// longer, and it fires whether you landed the hit or took it, so both
// sides of an exchange feel the weight of it.
const HIT_STOP_MS = { normal: 35, charged: 65, special: 95, throw: 120, drop: 0 };
let hitStopMs = 0;
function triggerHitStop(power) {
  hitStopMs = Math.max(hitStopMs, HIT_STOP_MS[power] ?? 35);
}

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

// Spectator overview: after being eliminated, the camera stays on the
// player's own falling/dying body for a moment (so the death effect
// actually gets seen) before easing up into a high overview of the whole
// arena — so there's something to watch for the rest of the round instead
// of just staring at wherever your corpse settled. See loop()'s camera
// branch and sceneManager.updateSpectatorCamera.
const SPECTATE_DELAY_MS = 1800;
let isSpectating = false;
let spectateTimer = null;
function clearSpectateTimer() {
  if (spectateTimer) {
    clearTimeout(spectateTimer);
    spectateTimer = null;
  }
}

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
  // Only on the false->true edge — every specialProgress event while
  // already ready would otherwise replay the chime on every subsequent
  // charged hit landed before it's actually used.
  if (ready && !specialReady) playSpecialReady();
  specialReady = ready;
  specialPipEls.forEach((pip, i) => pip.classList.toggle('filled', i < count));
  specialMeterEl?.classList.toggle('ready', ready);
  // Minimal on purpose: the pips already show progress visually, so the
  // text only needs to add the one thing they can't — what to press. A
  // count ("2 / 3") reads just as clearly as a full sentence here.
  if (specialHintEl) {
    specialHintEl.textContent = ready
      ? (isTouchDevice() ? 'READY — tap KICK' : 'READY — press Q')
      : `${count} / ${threshold}`;
  }
  setSpecialReady(ready);
}

// power -> a punchy past-tense verb, distinct per tier so the method of
// elimination reads at a glance, not just who-vs-who.
const KILL_VERB = {
  normal: 'shoved',
  charged: 'smashed',
  special: 'kicked',
  throw: 'launched',
  drop: 'dropped'
};
const KILL_FEED_MAX_ENTRIES = 4;
const KILL_FEED_LIFETIME_MS = 5000;

// killerName === null means unassisted — fell on their own, or the hit
// that caused it was too long ago to credit (see the server's
// KILL_ATTRIBUTION_MS). Built with textContent/createTextNode throughout,
// never innerHTML — player names are user-provided (the login name field)
// and this project already fixed one XSS bug from rendering user text via
// innerHTML elsewhere; not repeating that here.
function addKillFeedEntry(victimName, killerName, power) {
  if (!killFeedEl) return;
  const row = document.createElement('div');
  row.className = 'killFeedRow';

  if (killerName) {
    const killerSpan = document.createElement('span');
    killerSpan.className = 'killer';
    killerSpan.textContent = killerName;
    row.appendChild(killerSpan);
    row.appendChild(document.createTextNode(` ${KILL_VERB[power] || 'eliminated'} `));
    const victimSpan = document.createElement('span');
    victimSpan.className = 'victim';
    victimSpan.textContent = victimName;
    row.appendChild(victimSpan);
  } else {
    const victimSpan = document.createElement('span');
    victimSpan.className = 'victim';
    victimSpan.textContent = victimName;
    row.appendChild(victimSpan);
    row.appendChild(document.createTextNode(' fell'));
  }

  killFeedEl.prepend(row);
  while (killFeedEl.children.length > KILL_FEED_MAX_ENTRIES) {
    killFeedEl.removeChild(killFeedEl.lastChild);
  }
  setTimeout(() => {
    row.classList.add('fading');
    setTimeout(() => row.remove(), 400);
  }, KILL_FEED_LIFETIME_MS);
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
        // heldBy/holding are state-driven every broadcast, same pattern as
        // `alive` — the one-shot 'grabbed'/'released' events below only
        // drive the banner text and one-shot effects, not this flag, so a
        // dropped event packet can't leave the client stuck thinking it's
        // still held.
        localPlayer.setHeld(self.heldBy !== null);
        localPlayer.setHolding(self.holding);

        // While held, the server is fully authoritative over position (see
        // GameRoom#updateHeldPlayers) — track it directly instead of the
        // normal delta-based correction, which assumes the client is still
        // the one sending moves (it isn't; see loop()'s send-gate below).
        if (self.heldBy !== null) {
          localPlayer.setHeldTarget(self.x, self.y, self.z);
        } else {
          localPlayer.applyServerCorrection(self.x, self.z, lastSentX, lastSentZ);
        }
      }
    },
    onShoveAction: ({ playerId, power }) => {
      playShove(power);
      if (playerId === selfId) localPlayer?.playPunch(power);
      else remotePlayers.playPunch(playerId, power);

      if (power && power !== 'normal') {
        const pos = playerId === selfId ? localPlayer?.avatar.group.position : remotePlayers.getPosition(playerId);
        if (pos) {
          const EFFECT_BY_POWER = {
            charged: { color: 0xffcc33, scaleMult: 1, duration: 0.45 },
            special: { color: 0x66e0ff, scaleMult: 1.7, duration: 0.6 },
            throw: { color: 0xff5522, scaleMult: 2, duration: 0.65 }
          };
          sceneManager.spawnShockwave(pos, EFFECT_BY_POWER[power] || EFFECT_BY_POWER.charged);
        }
      }
    },
    onShoveHit: (data) => {
      if (data.targetId === selfId && localPlayer) {
        localPlayer.applyKnockback(data.dirX, data.dirZ, data.force, data.upForce);
        if (data.power === 'charged') sceneManager.shake(0.25, 250);
        else if (data.power === 'special') sceneManager.shake(0.45, 400);
        else if (data.power === 'throw') sceneManager.shake(0.6, 500);
        // 'drop' (an un-thrown release, see GameRoom#dropHeld) is
        // deliberately gentle — no shake, it's an "oops" not a hit.
      }
      // Both sides of a landed hit feel the impact pause — whether you
      // took it or dealt it — but not a drop, which isn't really a "hit".
      if (data.targetId === selfId || data.sourceId === selfId) {
        triggerHitStop(data.power);
      }
    },
    onSpecialProgress: ({ count, threshold, ready }) => updateSpecialUI(count, threshold, ready),
    onGrabbed: ({ holderId, targetId }) => {
      playGrab();
      if (targetId === selfId) {
        showBanner('Grabbed!', 'Brace yourself...');
      } else if (holderId === selfId) {
        // localPlayer.holding itself is set from the next 'state' broadcast
        // (see onState) — this is just the immediate flavor text.
        hideBanner();
      }
    },
    onReleased: ({ targetId, thrown }) => {
      if (targetId === selfId) {
        hideBanner();
        // No natural "next event" clears this one promptly the way the
        // eliminated/round-over banners get replaced, so it just times
        // itself out.
        if (!thrown) { showBanner('Dropped!', ''); setTimeout(hideBanner, 1800); }
      }
      // Throw/drop knockback itself arrives via the normal onShoveHit
      // above (power: 'throw' | 'drop') — this event is purely for
      // clearing the "You've been grabbed!" banner and local flag state.
    },
    onEliminated: ({ id, name, killerId, killerName, power }) => {
      playEliminate();
      addKillFeedEntry(name, killerId === id ? null : killerName, power);
      if (id === selfId) {
        sceneManager.spawnDeathEffect(localPlayer.avatar.group.position, selfColor);
        localPlayer.setAlive(false);
        controlsEnabled = false;
        showBanner('Eliminated', 'Spectating...');
        clearSpectateTimer();
        spectateTimer = setTimeout(() => { isSpectating = true; }, SPECTATE_DELAY_MS);
      }
    },
    onRoundOver: (data) => {
      controlsEnabled = false;
      playRoundWin();
      const titleText = data.winnerId === selfId
        ? 'You win!'
        : data.winnerName ? `${data.winnerName} wins!` : 'Round over';
      startRestartCountdown(titleText, data.restartInMs ?? 5000);
    },
    onRoundStart: (data) => {
      clearRestartCountdown();
      clearSpectateTimer();
      isSpectating = false;
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
      clearSpectateTimer();
      isSpectating = false;
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
      case 'ShiftLeft': case 'ShiftRight': keys.sprint = true; break;
      case 'KeyF': if (!e.repeat) onShovePress(); break;
      case 'KeyQ': if (!e.repeat) fireSpecial(); break;
      case 'KeyE': if (!e.repeat) fireGrab(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = false; break;
      case 'KeyA': case 'ArrowLeft': keys.a = false; break;
      case 'KeyS': case 'ArrowDown': keys.s = false; break;
      case 'KeyD': case 'ArrowRight': keys.d = false; break;
      case 'Space': keys.space = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.sprint = false; break;
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
      onGrabTrigger: fireGrab,
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

// Sends a shove if the cooldown allows it; silently does nothing otherwise
// (matches the existing tap-on-cooldown behavior).
function fireShove(power) {
  if (!controlsEnabled || !localPlayer?.alive || localPlayer?.isHeld) return;
  const now = performance.now();
  if (now - lastShoveClientTime < SHOVE_COOLDOWN_MS) return;
  lastShoveClientTime = now;
  network.sendShove(power);
}

// Press: start charging (unless already on cooldown, in which case this
// hold does nothing — matches a tap's existing silent-no-op-on-cooldown
// behavior). The loop() below advances the charge bar toward full but does
// NOT fire anything by itself — nothing happens until release (see below).
//
// Holding someone is the one exception to "hold to charge": a 2s charge
// flow doesn't make sense while your hands are already full, so pressing
// shove while holding just immediately throws instead (see
// GameRoom#handleShove's own holding-check, which is what actually
// converts this into a throw server-side — this just fires without
// starting a charge cycle).
function onShovePress() {
  if (fShoveHeld) return;
  fShoveHeld = true;
  if (!controlsEnabled || !localPlayer?.alive || localPlayer?.isHeld) return;
  if (localPlayer?.holding) { fireShove('normal'); return; }
  if (performance.now() - lastShoveClientTime < SHOVE_COOLDOWN_MS) return;
  chargeStartTime = performance.now();
}

// A ring at ~98% is visually indistinguishable from 100% (a 353°-drawn
// conic-gradient looks like a full circle), so people reliably release the
// instant it *looks* full — reaction time alone then lands the real
// elapsed time just under CHARGE_HOLD_MS, firing a 'normal' shove despite
// looking fully charged. This grace window makes "looks full" reliably
// count as charged instead of requiring the exact millisecond.
const CHARGE_FIRE_GRACE_MS = 150;

// Release fires exactly one shove: 'charged' if the hold reached
// CHARGE_HOLD_MS (within the grace window above), otherwise 'normal' for
// a quick tap. Holding past full just keeps the bar pinned at 100% and
// waits — it never auto-fires or restarts a new charge on its own; only an
// explicit release (this function) ever sends a shove.
function onShoveRelease() {
  if (!fShoveHeld) return;
  fShoveHeld = false;
  if (chargeStartTime !== null) {
    const elapsed = performance.now() - chargeStartTime;
    fireShove(elapsed >= CHARGE_HOLD_MS - CHARGE_FIRE_GRACE_MS ? 'charged' : 'normal');
  }
  chargeStartTime = null;
  updateChargeUI(0);
}

function fireSpecial() {
  if (!specialReady) return;
  fireShove('special');
}

// No cooldown/range check here — the server validates both (see
// GameRoom#handleGrab) and silently no-ops a whiffed grab exactly like a
// whiffed shove, so this just forwards the intent.
function fireGrab() {
  if (!controlsEnabled || !localPlayer?.alive || localPlayer?.isHeld || localPlayer?.holding) return;
  network.sendGrab();
}

let lastTime = performance.now();
let sendAccumulator = 0;
const sendInterval = 1 / NETWORK_SEND_HZ;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // Hit-stop: scale dt way down (not literally to 0 — keeps downstream
  // math like easing/decay well-behaved) for a few real milliseconds after
  // a landed hit, so physics/animation nearly freeze for a beat. Purely a
  // local, cosmetic time-dilation — nothing here touches what gets sent to
  // or trusted from the server.
  if (hitStopMs > 0) {
    hitStopMs -= dt * 1000;
    dt *= 0.06;
  }

  if (localPlayer) {
    localPlayer.update(controlsEnabled ? keys : { w: false, a: false, s: false, d: false, space: false, sprint: false }, dt, cameraYaw);

    // A hard landing is a real physical impact too, not just a combat
    // hit — give it the same hit-stop treatment (scaled down for a small
    // hop, up to the same weight as a normal shove for a full jump) plus
    // a dust-ring effect at the feet, so landing reads as an actual event
    // instead of just... stopping falling.
    if (localPlayer.justLandedIntensity > 0) {
      triggerHitStop(localPlayer.justLandedIntensity > 0.5 ? 'normal' : 'drop');
      sceneManager.spawnShockwave(localPlayer.position, {
        color: 0xcbb896,
        scaleMult: 0.6 + localPlayer.justLandedIntensity * 0.6,
        duration: 0.3
      });
      localPlayer.justLandedIntensity = 0;
    }

    if (isSpectating) {
      sceneManager.updateSpectatorCamera(localPlayer.arenaRadius, dt);
    } else {
      sceneManager.updateCamera(localPlayer.position, cameraYaw, cameraPitch, dt);
    }
    // Only meaningful for the local player — remote sprinters don't affect
    // this client's own camera. Gated on isHeld too since a held player's
    // keys.sprint doesn't drive anything (LocalPlayer#update ignores it
    // entirely while held) and shouldn't visually widen their FOV either.
    sceneManager.setSprinting(controlsEnabled && !localPlayer.isHeld && keys.sprint);

    sendAccumulator += dt;
    if (sendAccumulator >= sendInterval) {
      sendAccumulator = 0;
      // Only stream position while alive AND not held. The server already
      // ignores move updates in both cases (GameRoom.updateFromClient), but
      // there's a race for the alive case: this client keeps free-falling
      // its own view for the dramatic drop the whole time it's dead/
      // spectating (which can be several seconds, arbitrarily far below the
      // map), and a packet sent during that fall can still be in flight
      // when the round restarts and the server flips this player back to
      // alive - at which point that stale packet would be accepted,
      // snapping the freshly-spawned player back into "still falling"
      // territory and instantly re-eliminating them, restarting the round
      // again. Never sending while dead/held means no such stale packet
      // can ever be in flight to race against a respawn or a release.
      if (localPlayer.alive && !localPlayer.isHeld) {
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

  // Advance the shove charge bar while held. Caps at 100% and just sits
  // there — firing only happens on release (onShoveRelease), never here,
  // so holding past full doesn't auto-fire or restart anything on its own.
  if (fShoveHeld && chargeStartTime !== null) {
    if (!controlsEnabled || !localPlayer?.alive) {
      chargeStartTime = null;
      updateChargeUI(0);
    } else {
      const elapsed = now - chargeStartTime;
      updateChargeUI(Math.min(1, elapsed / CHARGE_HOLD_MS));
    }
  }

  remotePlayers?.tick(dt);
  sceneManager?.updateEffects(dt);
  sceneManager?.render();

  // Read-only debug hook (harmless, no gameplay effect) so external tooling
  // can inspect ground-truth camera/player state instead of guessing it.
  window.__debug = { cameraYaw, cameraPitch, position: localPlayer?.position, alive: localPlayer?.alive };
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
  // Must happen inside this click handler specifically — AudioContext
  // requires a real user gesture to start, and this is the first one in
  // the whole app's lifecycle.
  initAudio();
  if (isTouchDevice()) requestFullscreenSafe();
  startGame(name);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playBtn.click();
});
