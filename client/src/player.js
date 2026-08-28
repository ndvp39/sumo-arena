import * as THREE from 'three';
import { GRAVITY, JUMP_SPEED, MOVE_SPEED, GROUND_Y, KNOCKBACK_DECAY } from './constants.js';
import { createAvatar, updateAvatar, triggerPunch } from './avatar.js';

// Local player: fully client-simulated movement/gravity/jump for zero input
// lag. The server only ever validates the *consequences* (boundary,
// collision, shove) — it never overrides raw WASD motion, so this class
// owns the source of truth for the local player's transform.
export class LocalPlayer {
  constructor(name, color, scene) {
    this.position = new THREE.Vector3(0, GROUND_Y, 0);
    this.velocityY = 0;
    this.rotY = 0;
    this.grounded = true;
    this.alive = true;

    this.knockback = new THREE.Vector3(0, 0, 0);
    this.arenaRadius = Infinity; // set via setArenaRadius() once a map is known
    this.serverTarget = null; // latest authoritative x/z, eased toward in update() — not snapped instantly

    this.avatar = createAvatar(name, color);
    scene.add(this.avatar.group);
  }

  setArenaRadius(radius) {
    this.arenaRadius = radius;
  }

  applyKnockback(dirX, dirZ, force, upForce) {
    this.knockback.x = dirX * force;
    this.knockback.z = dirZ * force;
    this.velocityY = upForce;
    this.grounded = false;
  }

  playPunch() {
    triggerPunch(this.avatar, performance.now());
  }

  setAlive(alive) {
    this.alive = alive;
  }

  // cameraYaw: current mouse-look yaw (radians), used only to resolve WASD
  // into a world-space direction (W = into the view, D = strafe right
  // relative to view, ...). The avatar's own facing is independent of the
  // camera — it turns to face wherever it's actually moving, like a
  // standard third-person controller (camera and character rotation are
  // decoupled; only the camera responds to the mouse). Independent per-key
  // state (not mutually exclusive) means diagonals (W+D, ...) and
  // jumping/shoving while moving all just work — nothing here gates one
  // input on another.
  update(keys, dt, cameraYaw) {
    if (this.alive) {
      const moveForward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
      const moveRight = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
      const hasInput = moveForward !== 0 || moveRight !== 0;

      if (hasInput) {
        const fx = Math.sin(cameraYaw), fz = Math.cos(cameraYaw);
        const rx = -Math.cos(cameraYaw), rz = Math.sin(cameraYaw);

        let dx = fx * moveForward + rx * moveRight;
        let dz = fz * moveForward + rz * moveRight;
        const len = Math.hypot(dx, dz);
        dx = (dx / len) * MOVE_SPEED;
        dz = (dz / len) * MOVE_SPEED;

        this.position.x += dx * dt;
        this.position.z += dz * dt;
        this.rotY = Math.atan2(dx, dz);
      }

      if (keys.space && this.grounded) {
        this.velocityY = JUMP_SPEED;
        this.grounded = false;
      }
    }

    this._easeTowardServerTarget(dt);

    // Knockback eases out independently of normal movement input.
    this.position.x += this.knockback.x * dt;
    this.position.z += this.knockback.z * dt;
    const decay = Math.exp(-KNOCKBACK_DECAY * dt);
    this.knockback.x *= decay;
    this.knockback.z *= decay;

    this.velocityY -= GRAVITY * dt;
    this.position.y += this.velocityY * dt;

    // Only clamp to ground while actually over the platform. Past the edge
    // (walked or knocked off), gravity keeps pulling down with nothing to
    // land on — a real fall into the void instead of sliding along y=0 —
    // until the server's elimination threshold catches it.
    const distFromCenter = Math.hypot(this.position.x, this.position.z);
    if (distFromCenter <= this.arenaRadius) {
      if (this.position.y <= GROUND_Y) {
        this.position.y = GROUND_Y;
        this.velocityY = 0;
        this.grounded = true;
      }
    } else {
      this.grounded = false;
    }

    this.avatar.group.position.copy(this.position);
    this.avatar.group.rotation.y = this.rotY;
    updateAvatar(this.avatar, performance.now(), this.alive);
  }

  respawn(x, z, rotY) {
    this.position.set(x, GROUND_Y, z);
    this.velocityY = 0;
    this.knockback.set(0, 0, 0);
    this.rotY = rotY;
    this.grounded = true;
    this.alive = true;
    this.avatar.fallProgress = 0;
    this.avatar.group.rotation.z = 0;
  }

  // Records the server's authoritative position (used after server-side
  // collision resolution nudges this player apart from another). Doesn't
  // move anything itself — update() eases toward it gradually, once per
  // render frame, instead of snapping instantly on each network packet
  // (which read as a visible jerk ~30x/sec).
  applyServerCorrection(x, z) {
    const dist = Math.hypot(x - this.position.x, z - this.position.z);
    this.serverTarget = dist > 0.55 ? { x, z } : null;
  }

  _easeTowardServerTarget(dt) {
    if (!this.serverTarget) return;
    const dx = this.serverTarget.x - this.position.x;
    const dz = this.serverTarget.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.02) {
      this.serverTarget = null;
      return;
    }
    const alpha = 1 - Math.exp(-8 * dt); // framerate-independent, ~8/s convergence
    this.position.x += dx * alpha;
    this.position.z += dz * alpha;
  }
}
