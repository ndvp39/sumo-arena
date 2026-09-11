import { createAvatar, updateAvatar, triggerPunch, resetAvatarVisuals } from './avatar.js';
import { REMOTE_LERP_FACTOR } from './constants.js';

// Manages every non-local player's avatar: creation/removal, smoothing
// toward the latest server snapshot each frame (so movement doesn't
// stutter between the ~20-30Hz network updates), and remote animations.
export class RemotePlayers {
  // onEliminated(position, color): optional callback fired the moment a
  // tracked remote player's alive flag flips true -> false, so main.js can
  // trigger the death effect (blood splat/limb pop) without RemotePlayers
  // needing to know anything about SceneManager itself.
  constructor(scene, onEliminated) {
    this.scene = scene;
    this.onEliminated = onEliminated;
    this.map = new Map(); // id -> { avatar, target: {x,y,z,rotY}, alive }
  }

  add(playerData) {
    if (this.map.has(playerData.id)) return;
    const avatar = createAvatar(playerData.name, playerData.color);
    avatar.group.position.set(playerData.x, playerData.y, playerData.z);
    avatar.group.rotation.y = playerData.rotY;
    this.scene.add(avatar.group);
    this.map.set(playerData.id, {
      avatar,
      target: { x: playerData.x, y: playerData.y, z: playerData.z, rotY: playerData.rotY },
      alive: playerData.alive,
      // heldBy/holding are state-driven from every 'state' broadcast (see
      // updateFromState) — same pattern as `alive` — rather than only
      // trusting the one-shot 'grabbed'/'released' events, so a dropped
      // packet can't leave a client stuck thinking someone is still held.
      heldBy: playerData.heldBy ?? null,
      holding: playerData.holding ?? null
    });
  }

  remove(id) {
    const entry = this.map.get(id);
    if (!entry) return;
    this.scene.remove(entry.avatar.group);
    this.map.delete(id);
  }

  removeAll() {
    for (const id of [...this.map.keys()]) this.remove(id);
  }

  updateFromState(players, selfId) {
    for (const p of players) {
      if (p.id === selfId) continue;
      let entry = this.map.get(p.id);
      if (!entry) {
        this.add(p);
        entry = this.map.get(p.id);
      }
      entry.target.x = p.x;
      entry.target.y = p.y;
      entry.target.z = p.z;
      entry.target.rotY = p.rotY;
      entry.heldBy = p.heldBy ?? null;
      entry.holding = p.holding ?? null;

      const wasAlive = entry.alive;
      entry.alive = p.alive;
      if (wasAlive && !p.alive) {
        this.onEliminated?.(entry.avatar.group.position, p.color);
      }
    }
  }

  playPunch(id, power = 'normal') {
    const entry = this.map.get(id);
    if (entry) triggerPunch(entry.avatar, performance.now(), power);
  }

  getPosition(id) {
    return this.map.get(id)?.avatar.group.position ?? null;
  }

  respawnAll(players, selfId) {
    for (const p of players) {
      if (p.id === selfId) continue;
      const entry = this.map.get(p.id);
      if (!entry) continue;
      entry.avatar.group.position.set(p.x, p.y, p.z);
      entry.avatar.group.rotation.set(0, p.rotY, 0);
      resetAvatarVisuals(entry.avatar);
      entry.target = { x: p.x, y: p.y, z: p.z, rotY: p.rotY };
      entry.alive = true;
      entry.heldBy = null;
      entry.holding = null;
    }
  }

  tick(dt) {
    const alpha = 1 - Math.pow(1 - REMOTE_LERP_FACTOR, dt * 60);
    const now = performance.now();
    for (const entry of this.map.values()) {
      const { avatar, target } = entry;
      const isHeld = entry.heldBy !== null;

      const prevX = avatar.group.position.x;
      const prevZ = avatar.group.position.z;

      avatar.group.position.x += (target.x - avatar.group.position.x) * alpha;
      avatar.group.position.y += (target.y - avatar.group.position.y) * alpha;
      avatar.group.position.z += (target.z - avatar.group.position.z) * alpha;

      let deltaRot = target.rotY - avatar.group.rotation.y;
      deltaRot = Math.atan2(Math.sin(deltaRot), Math.cos(deltaRot));
      avatar.group.rotation.y += deltaRot * alpha;

      // No real velocity data for remote players — inferred from how far
      // the (already-smoothed) rendered position actually moved this
      // frame. Good enough for the walk-cycle's purposes, and skipped
      // entirely while held since a held avatar never walk-cycles anyway
      // (see avatar.js's priority order) regardless of how fast the
      // holder carrying them is moving.
      const moveSpeed = isHeld || dt <= 0
        ? 0
        : Math.hypot(avatar.group.position.x - prevX, avatar.group.position.z - prevZ) / dt;

      updateAvatar(avatar, now, dt, {
        isAlive: entry.alive,
        isHeld,
        isHolding: entry.holding !== null,
        moveSpeed
      });
    }
  }
}
