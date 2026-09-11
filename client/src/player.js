import * as THREE from 'three';
import { GRAVITY, JUMP_SPEED, MOVE_SPEED, GROUND_Y, KNOCKBACK_DECAY, DEATH_SETTLE_Y, SPRINT_MULTIPLIER } from './constants.js';
import { createAvatar, updateAvatar, triggerPunch, triggerLandSquash, resetAvatarVisuals } from './avatar.js';

// Landing speed (units/sec) at/above which a squash starts registering at
// all — a short hop shouldn't visibly squish, only a real fall/jump.
const LAND_SQUASH_MIN_SPEED = 3;
// Landing speed that maps to a full-intensity (1.0) squash — tuned well
// above LAND_SQUASH_MIN_SPEED so there's real range between "barely
// noticeable" and "full squash", not a near-binary on/off.
const LAND_SQUASH_MAX_SPEED = 16;

// How fast the local player's position eases toward the server-forced
// "held aloft" target (see setHeldTarget) — much faster than the normal
// ~8/s collision-correction rate, since a held player has no control of
// their own and should read as attached to the holder, not laggy.
const HELD_TRACK_RATE = 20;

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

    // Horizontal velocity carried into the air the instant grounded flips
    // false (jumping, or walking off an edge) — see update() for how it's
    // captured and coasted on.
    this.airVelX = 0;
    this.airVelZ = 0;

    // Grab/throw: isHeld means someone else is carrying THIS player (their
    // position is fully server-driven, see setHeldTarget/update's early
    // return); holding is the id of whoever THIS player is carrying (or
    // null) — see setHolding. Both are set from the server's state
    // broadcast (main.js), the same state-driven pattern `alive` uses.
    this.isHeld = false;
    this.holding = null;

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

  playPunch(power = 'normal') {
    triggerPunch(this.avatar, performance.now(), power);
  }

  setAlive(alive) {
    this.alive = alive;
  }

  // held: whether someone else is currently carrying this player. Clearing
  // the stale server-tracking target on release matters: without it, the
  // last "track the holder" target would otherwise keep tugging the
  // freshly-freed position toward wherever the holder was a moment ago.
  setHeld(held) {
    this.isHeld = held;
    if (!held) this.serverTarget = null;
  }

  setHolding(holdingId) {
    this.holding = holdingId;
  }

  // Called from onState while held, with the server's authoritative
  // (holder.x, holder.y + HELD_OFFSET_Y, holder.z). Y is snapped directly
  // (a holder's height rarely changes fast enough to need easing); X/Z go
  // through the normal serverTarget mechanism but eased at HELD_TRACK_RATE
  // instead of the default correction rate — see update()'s isHeld branch.
  setHeldTarget(x, y, z) {
    this.serverTarget = { x, z };
    this.position.y = y;
  }

  // cameraYaw: current mouse-look yaw (radians), used only to resolve WASD
  // into a world-space direction (W = into the view, D = strafe right
  // relative to view, ...). The avatar's own facing is independent of the
  // camera — it turns to face wherever it's actually moving, like a
  // standard third-person controller (camera and character rotation are
  // decoupled; only the camera responds to the mouse). Independent per-key
  // state (not mutually exclusive) means jumping/shoving while moving all
  // just work — nothing here gates one input on another.
  //
  // Grounded movement is direct/instant (position set straight from
  // current input, no acceleration) for snappy WASD control. The moment
  // grounded goes false — jumping, or walking off an edge — whatever
  // horizontal velocity was just active gets carried into the air as
  // airVelX/Z and WASD stops being read entirely: no redirecting, no
  // adding more speed, just coasting on real momentum until landing,
  // like an actual physics-driven jump/fall instead of a frozen one.
  // keys.sprint (Shift on desktop, pushing the joystick past its threshold
  // on mobile) raises MOVE_SPEED for this frame's normalization only —
  // whatever speed was active at takeoff is what gets carried into
  // airVelX/Z automatically, so a sprinting jump keeps sprinting speed
  // through the air for free.
  update(keys, dt, cameraYaw) {
    if (this.isHeld) {
      // Fully server-driven while held: no local physics, no gravity, no
      // input at all — just track the holder's reported position/height
      // (see setHeldTarget), eased quickly so it reads as attached rather
      // than laggy. Mouse look still works (main.js never gates cameraYaw
      // on isHeld), just WASD/jump/shove/grab don't apply here.
      this._easeTowardServerTarget(dt, HELD_TRACK_RATE);
      this.avatar.group.position.copy(this.position);
      this.avatar.group.rotation.y = this.rotY;
      updateAvatar(this.avatar, performance.now(), dt, { isAlive: this.alive, isHeld: true });
      return;
    }

    let moveSpeed = 0;
    // Captured before anything below can change it, so the ground-clamp
    // further down can tell "still grounded" apart from "just landed" —
    // triggerLandSquash should only fire on that actual falling->grounded
    // edge, not on every single grounded frame.
    const wasGrounded = this.grounded;

    if (this.alive) {
      if (this.grounded) {
        const moveForward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
        const moveRight = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
        const hasInput = moveForward !== 0 || moveRight !== 0;

        let dx = 0, dz = 0;
        if (hasInput) {
          const fx = Math.sin(cameraYaw), fz = Math.cos(cameraYaw);
          const rx = -Math.cos(cameraYaw), rz = Math.sin(cameraYaw);

          dx = fx * moveForward + rx * moveRight;
          dz = fz * moveForward + rz * moveRight;
          const len = Math.hypot(dx, dz);
          const speed = keys.sprint ? MOVE_SPEED * SPRINT_MULTIPLIER : MOVE_SPEED;
          dx = (dx / len) * speed;
          dz = (dz / len) * speed;

          this.position.x += dx * dt;
          this.position.z += dz * dt;
          this.rotY = Math.atan2(dx, dz);
        }
        // Kept current every grounded frame so it's always ready to be
        // the exact launch velocity the instant grounded flips false,
        // whether that's from pressing Space below or from the ground
        // clamp further down finding you past the platform's edge.
        this.airVelX = dx;
        this.airVelZ = dz;
        moveSpeed = Math.hypot(dx, dz);
      } else {
        this.position.x += this.airVelX * dt;
        this.position.z += this.airVelZ * dt;
        moveSpeed = Math.hypot(this.airVelX, this.airVelZ);
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
        // Squash-and-stretch, scaled by how fast the fall actually was —
        // a small hop barely registers, a real fall squishes hard. Reads
        // velocityY (still the pre-landing fall speed here) before it
        // gets reset to 0 on the next line.
        if (!wasGrounded) {
          const intensity = (-this.velocityY - LAND_SQUASH_MIN_SPEED) / (LAND_SQUASH_MAX_SPEED - LAND_SQUASH_MIN_SPEED);
          if (intensity > 0) triggerLandSquash(this.avatar, intensity);
        }
        this.position.y = GROUND_Y;
        this.velocityY = 0;
        this.grounded = true;
      }
    } else {
      this.grounded = false;
    }

    // Once eliminated, settle just under the liquid surface instead of
    // falling forever — otherwise the camera (which keeps following this
    // position every frame regardless of alive state) chases the body down
    // out of view, and the death effect spawned back at the elimination
    // point is left behind before anyone can actually see it.
    if (!this.alive && this.position.y <= DEATH_SETTLE_Y) {
      this.position.y = DEATH_SETTLE_Y;
      this.velocityY = 0;
    }

    this.avatar.group.position.copy(this.position);
    this.avatar.group.rotation.y = this.rotY;
    updateAvatar(this.avatar, performance.now(), dt, {
      isAlive: this.alive,
      isHolding: this.holding !== null,
      moveSpeed
    });
  }

  respawn(x, z, rotY) {
    this.position.set(x, GROUND_Y, z);
    this.velocityY = 0;
    this.knockback.set(0, 0, 0);
    this.airVelX = 0;
    this.airVelZ = 0;
    this.rotY = rotY;
    this.grounded = true;
    this.alive = true;
    this.isHeld = false;
    this.holding = null;
    resetAvatarVisuals(this.avatar);
    // A stale correction from before death (e.g. still converging when
    // eliminated) would otherwise ease the fresh spawn position back
    // toward the out-of-bounds spot the player died at.
    this.serverTarget = null;
  }

  // Records a genuine server-side adjustment (e.g. collision push-apart),
  // as distinct from ordinary network latency. `sentX/sentZ` is the
  // transform we last told the server; comparing the server's echoed
  // x/z against THAT (rather than against our current live position)
  // isolates what the server actually changed, since both values sit on
  // the same timeline — the raw echo is always "live position minus one
  // network round-trip," which would otherwise look like a huge false
  // correction under any real-world latency. Doesn't move anything itself
  // — update() eases toward it gradually, once per render frame, instead
  // of snapping instantly on each network packet.
  applyServerCorrection(x, z, sentX, sentZ) {
    const dx = x - sentX;
    const dz = z - sentZ;
    const dist = Math.hypot(dx, dz);
    this.serverTarget = dist > 0.05
      ? { x: this.position.x + dx, z: this.position.z + dz }
      : null;
  }

  // rate: convergence speed in 1/s — defaults to the gentle ~8/s used for
  // ordinary collision corrections; the isHeld path in update() passes
  // HELD_TRACK_RATE instead for much snappier tracking of a fast-moving
  // holder.
  _easeTowardServerTarget(dt, rate = 8) {
    if (!this.serverTarget) return;
    const dx = this.serverTarget.x - this.position.x;
    const dz = this.serverTarget.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.02) {
      this.serverTarget = null;
      return;
    }
    const alpha = 1 - Math.exp(-rate * dt); // framerate-independent convergence
    this.position.x += dx * alpha;
    this.position.z += dz * alpha;
  }
}
