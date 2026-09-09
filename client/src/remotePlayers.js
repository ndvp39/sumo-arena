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
      alive: playerData.alive
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
    }
  }

  tick(dt) {
    const alpha = 1 - Math.pow(1 - REMOTE_LERP_FACTOR, dt * 60);
    for (const entry of this.map.values()) {
      const { avatar, target } = entry;
      avatar.group.position.x += (target.x - avatar.group.position.x) * alpha;
      avatar.group.position.y += (target.y - avatar.group.position.y) * alpha;
      avatar.group.position.z += (target.z - avatar.group.position.z) * alpha;

      let deltaRot = target.rotY - avatar.group.rotation.y;
      deltaRot = Math.atan2(Math.sin(deltaRot), Math.cos(deltaRot));
      avatar.group.rotation.y += deltaRot * alpha;

      updateAvatar(avatar, performance.now(), entry.alive);
    }
  }
}
