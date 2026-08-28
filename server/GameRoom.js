import {
  PLAYER_RADIUS, ELIMINATION_Y,
  SHOVE_RANGE, SHOVE_FORCE, SHOVE_UP_FORCE, SHOVE_COOLDOWN_MS,
  TICK_RATE_HZ, ROUND_RESTART_DELAY_MS, MIN_PLAYERS_TO_START,
  PLAYER_COLORS
} from './constants.js';
import { getMap, nextMapId, DEFAULT_MAP_ID } from './maps.js';

// Authoritative game room: owns player state, boundary/collision/knockback
// resolution and round lifecycle. Movement itself is client-simulated for
// responsiveness; this room validates it (elimination, overlap) each tick.
//
// Map-aware by design: all arena geometry (radius, spawn ring) comes from
// `this.map`, loaded from the maps.js registry. Swapping maps is just
// `this.map = getMap(newId)` — no other logic depends on a specific arena.
export class GameRoom {
  constructor(io, mapId = DEFAULT_MAP_ID) {
    this.io = io;
    this.players = new Map(); // id -> player state
    this.nextColorIndex = 0;
    this.roundActive = true;
    this.restartTimer = null;
    this.map = getMap(mapId);
  }

  spawnPoint(index) {
    const total = Math.max(this.players.size + 1, MIN_PLAYERS_TO_START);
    const angle = (index / total) * Math.PI * 2;
    const r = this.map.spawnRadius;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // Face the arena center. The client's forward vector convention is
    // (sin(rotY), cos(rotY)) (see player.js / scene.js camera), so facing
    // toward (0,0,0) from (x,z) means rotY = atan2(-x, -z), NOT angle + PI.
    const rotY = Math.atan2(-x, -z);
    return { x, z, rotY };
  }

  addPlayer(id, name) {
    const index = this.players.size;
    const { x, z, rotY } = this.spawnPoint(index);
    const color = PLAYER_COLORS[this.nextColorIndex % PLAYER_COLORS.length];
    this.nextColorIndex++;

    const player = {
      id,
      name: (name || 'Player').slice(0, 16),
      color,
      x, y: 0, z, rotY,
      alive: true,
      lastShoveTime: 0
    };
    this.players.set(id, player);
    this.roundActive = true;
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.checkWinCondition();
  }

  updateFromClient(id, data) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;
    // Trust client-simulated transform; server still validates boundary/collision each tick.
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.rotY = data.rotY || 0;
  }

  handleShove(id) {
    const pusher = this.players.get(id);
    if (!pusher || !pusher.alive || !this.roundActive) return;

    const now = Date.now();
    if (now - pusher.lastShoveTime < SHOVE_COOLDOWN_MS) return;
    pusher.lastShoveTime = now;

    this.io.emit('shoveAction', { playerId: id });

    // Omnidirectional: any alive player within range gets pushed away from
    // the pusher, no facing/cone requirement. Simpler and more forgiving —
    // matches classic sumo "get close and shove" play instead of requiring
    // precise aim.
    for (const target of this.players.values()) {
      if (target.id === id || !target.alive) continue;
      const dx = target.x - pusher.x;
      const dz = target.z - pusher.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SHOVE_RANGE || dist < 0.0001) continue;

      const ndx = dx / dist;
      const ndz = dz / dist;

      this.io.emit('shoveHit', {
        sourceId: id,
        targetId: target.id,
        dirX: ndx,
        dirZ: ndz,
        force: SHOVE_FORCE,
        upForce: SHOVE_UP_FORCE
      });
    }
  }

  resolveCollisions() {
    const alive = [...this.players.values()].filter(p => p.alive);
    const minDist = PLAYER_RADIUS * 2;

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= minDist || dist < 0.0001) continue;

        const overlap = (minDist - dist) / 2;
        const nx = dx / dist;
        const nz = dz / dist;
        a.x -= nx * overlap;
        a.z -= nz * overlap;
        b.x += nx * overlap;
        b.z += nz * overlap;
      }
    }
  }

  // Being past the ring boundary doesn't eliminate you by itself — the
  // client only clamps to ground while over the platform, so stepping off
  // the edge starts a real fall under gravity. Elimination is purely
  // depth-based: you're out once you've fallen far enough (ELIMINATION_Y),
  // which gives that fall a visible ~1.2s before it counts.
  checkEliminations() {
    let anyEliminated = false;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      if (player.y < ELIMINATION_Y) {
        player.alive = false;
        anyEliminated = true;
        this.io.emit('playerEliminated', { id: player.id });
      }
    }
    if (anyEliminated) this.checkWinCondition();
  }

  checkWinCondition() {
    if (!this.roundActive) return;
    const totalPlayers = this.players.size;
    const alivePlayers = [...this.players.values()].filter(p => p.alive);

    if (totalPlayers >= MIN_PLAYERS_TO_START && alivePlayers.length <= 1) {
      this.roundActive = false;
      const winner = alivePlayers[0] || null;
      this.io.emit('roundOver', {
        winnerId: winner ? winner.id : null,
        winnerName: winner ? winner.name : null,
        restartInMs: ROUND_RESTART_DELAY_MS
      });
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restartRound(), ROUND_RESTART_DELAY_MS);
  }

  // Rotates to the next map in the registry each restart so every configured
  // map gets played automatically — add a map to maps.js and it joins the rotation.
  restartRound() {
    if (this.players.size < MIN_PLAYERS_TO_START) {
      this.roundActive = true;
      return;
    }

    this.map = getMap(nextMapId(this.map.id));

    let index = 0;
    for (const player of this.players.values()) {
      const { x, z, rotY } = this.spawnPoint(index++);
      player.x = x;
      player.y = 0;
      player.z = z;
      player.rotY = rotY;
      player.alive = true;
    }
    this.roundActive = true;
    this.io.emit('roundStart', { map: this.serializeMap(), players: this.serializeAll() });
  }

  tick() {
    if (this.roundActive) {
      this.resolveCollisions();
      this.checkEliminations();
    }
    this.io.emit('state', { players: this.serializeAll() });
  }

  serializePlayer(p) {
    return {
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, z: p.z, rotY: p.rotY,
      alive: p.alive
    };
  }

  serializeAll() {
    return [...this.players.values()].map(p => this.serializePlayer(p));
  }

  serializeMap() {
    const {
      id, name, radius, spawnRadius, height,
      groundColor, ringColor, voidColor, skyColor,
      lightColor, lightIntensity, ambientColor,
      emissiveGround, decoration
    } = this.map;
    return {
      id, name, radius, spawnRadius, height,
      groundColor, ringColor, voidColor, skyColor,
      lightColor, lightIntensity, ambientColor,
      emissiveGround, decoration
    };
  }

  start() {
    setInterval(() => this.tick(), 1000 / TICK_RATE_HZ);
  }
}
