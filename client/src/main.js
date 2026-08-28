import { SceneManager } from './scene.js';
import { LocalPlayer } from './player.js';
import { RemotePlayers } from './remotePlayers.js';
import { Network } from './network.js';
import { SHOVE_COOLDOWN_MS, NETWORK_SEND_HZ, MOUSE_SENSITIVITY, PITCH_MIN, PITCH_MAX } from './constants.js';

const loginOverlay = document.getElementById('loginOverlay');
const nameInput = document.getElementById('nameInput');
const playBtn = document.getElementById('playBtn');
const hud = document.getElementById('hud');
const controlsHint = document.getElementById('controlsHint');
const mapNameEl = document.getElementById('mapName');
const aliveCountEl = document.getElementById('aliveCount');
const banner = document.getElementById('banner');
const mouseLookHint = document.getElementById('mouseLookHint');

let canvas;
let sceneManager, localPlayer, remotePlayers, network;
let selfId = null;
let controlsEnabled = false;
let lastShoveClientTime = 0;

const keys = { w: false, a: false, s: false, d: false, space: false };

// Mouse-look camera orbit state, driven by Pointer Lock (see setupInput).
// yaw/pitch are independent of the avatar's own transform — the avatar's
// facing is derived FROM cameraYaw each frame in player.js, not vice versa.
let cameraYaw = 0;
let cameraPitch = 0.25;

let restartCountdownTimer = null;

function showBanner(text, sub = '') {
  banner.innerHTML = `<div>${text}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
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
  controlsHint.style.display = 'block';
  if (mouseLookHint) mouseLookHint.style.display = 'block';

  canvas = document.createElement('canvas');
  document.getElementById('app').prepend(canvas);

  sceneManager = new SceneManager(canvas);
  remotePlayers = new RemotePlayers(sceneManager.scene);
  network = new Network();

  network.connect(name, {
    onInit: (data) => {
      selfId = data.selfId;
      sceneManager.buildArena(data.map);
      mapNameEl.textContent = `Map: ${data.map.name}`;

      const self = data.players.find(p => p.id === selfId);
      localPlayer = new LocalPlayer(name, self.color, sceneManager.scene);
      localPlayer.setArenaRadius(data.map.radius);
      localPlayer.respawn(self.x, self.z, self.rotY);
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
        localPlayer.applyServerCorrection(self.x, self.z);
      }
    },
    onShoveAction: (playerId) => {
      if (playerId === selfId) localPlayer?.playPunch();
      else remotePlayers.playPunch(playerId);
    },
    onShoveHit: (data) => {
      if (data.targetId === selfId && localPlayer) {
        localPlayer.applyKnockback(data.dirX, data.dirZ, data.force, data.upForce);
      }
    },
    onEliminated: (id) => {
      if (id === selfId) {
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
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': keys.w = true; break;
      case 'KeyA': keys.a = true; break;
      case 'KeyS': keys.s = true; break;
      case 'KeyD': keys.d = true; break;
      case 'Space': keys.space = true; e.preventDefault(); break;
      case 'KeyF': tryShove(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': keys.w = false; break;
      case 'KeyA': keys.a = false; break;
      case 'KeyS': keys.s = false; break;
      case 'KeyD': keys.d = false; break;
      case 'Space': keys.space = false; break;
    }
  });

  // Mouse-look via the Pointer Lock API: click the canvas to lock the
  // cursor, then raw mouse movement drives camera yaw/pitch until Escape
  // (or an unlock event) releases it again.
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (mouseLookHint) mouseLookHint.style.display = locked ? 'none' : 'block';
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    cameraYaw -= e.movementX * MOUSE_SENSITIVITY;
    cameraPitch += e.movementY * MOUSE_SENSITIVITY; // inverted: mouse-up looks the way mouse-down used to
    cameraPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cameraPitch));
  });
}

function tryShove() {
  if (!controlsEnabled || !localPlayer?.alive) return;
  const now = performance.now();
  if (now - lastShoveClientTime < SHOVE_COOLDOWN_MS) return;
  lastShoveClientTime = now;
  network.sendShove();
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
      network.sendMove({
        x: localPlayer.position.x,
        y: localPlayer.position.y,
        z: localPlayer.position.z,
        rotY: localPlayer.rotY
      });
    }
  }

  remotePlayers?.tick(dt);
  sceneManager?.render();

  // Read-only debug hook (harmless, no gameplay effect) so external tooling
  // can inspect ground-truth camera/player state instead of guessing it.
  window.__debug = { cameraYaw, cameraPitch, position: localPlayer?.position, alive: localPlayer?.alive };
}

playBtn.addEventListener('click', () => {
  const name = nameInput.value.trim() || `Player${Math.floor(Math.random() * 1000)}`;
  startGame(name);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playBtn.click();
});
