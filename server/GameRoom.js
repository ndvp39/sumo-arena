import {
  PLAYER_RADIUS, ELIMINATION_Y,
  SHOVE_RANGE, SHOVE_FORCE, SHOVE_UP_FORCE, SHOVE_COOLDOWN_MS,
  CHARGED_SHOVE_FORCE, CHARGED_SHOVE_UP_FORCE,
  SPECIAL_POWER_THRESHOLD, SPECIAL_KICK_RANGE, SPECIAL_KICK_FORCE, SPECIAL_KICK_UP_FORCE,
  GRAB_RANGE, GRAB_COOLDOWN_MS, HELD_OFFSET_Y, HOLD_MAX_MS,
  THROW_FORCE, THROW_UP_FORCE, DROP_FORCE, DROP_UP_FORCE,
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

  spawnPoint(index, total) {
    total = Math.max(total, MIN_PLAYERS_TO_START);
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
    const { x, z, rotY } = this.spawnPoint(index, this.players.size + 1);
    const color = PLAYER_COLORS[this.nextColorIndex % PLAYER_COLORS.length];
    this.nextColorIndex++;

    const player = {
      id,
      name: (name || 'Player').slice(0, 16),
      color,
      x, y: 0, z, rotY,
      alive: true,
      lastShoveTime: 0,
      chargedHitStreak: 0,
      specialReady: false,
      // Grab/throw: heldBy is the id of whoever is holding THIS player (or
      // null); holding is the id of whoever THIS player is holding (or
      // null). At most one of a player's own {holding, heldBy} pair is ever
      // meaningfully "active" at once — you can't hold someone while being
      // held yourself (see handleGrab).
      heldBy: null,
      holding: null,
      lastGrabTime: 0,
      grabbedAt: 0
    };
    this.players.set(id, player);
    this.roundActive = true;
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (player) {
      // Don't leave a captive stuck floating forever if their holder
      // disconnects, or leave a departing holder's "holding" pointer
      // dangling on whoever they were carrying.
      if (player.holding !== null) this.dropHeld(id);
      if (player.heldBy !== null) {
        const holder = this.players.get(player.heldBy);
        if (holder) holder.holding = null;
      }
    }
    this.players.delete(id);
    this.checkWinCondition();
  }

  updateFromClient(id, data) {
    const player = this.players.get(id);
    // A held player's transform is fully server-driven (see
    // updateHeldPlayers) — their own client isn't even simulating physics
    // while held, but ignore anything it sends anyway, same principle as
    // ignoring a dead player's moves.
    if (!player || !player.alive || player.heldBy !== null) return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;
    // Trust client-simulated transform; server still validates boundary/collision each tick.
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.rotY = data.rotY || 0;
  }

  // Grabbing has no charge/power tiers — it's a single lunge that either
  // lands on the nearest valid target in range or does nothing, same
  // "whiff costs you nothing but the cooldown" philosophy as a shove.
  handleGrab(id) {
    const pusher = this.players.get(id);
    if (!pusher || !pusher.alive || !this.roundActive) return;
    // Can't grab while already holding someone, or while held yourself.
    if (pusher.holding !== null || pusher.heldBy !== null) return;

    const now = Date.now();
    if (now - pusher.lastGrabTime < GRAB_COOLDOWN_MS) return;

    let closest = null;
    let closestDist = Infinity;
    for (const target of this.players.values()) {
      if (target.id === id || !target.alive) continue;
      // Can't grab someone who's already held, or who's themselves in the
      // middle of holding a third player — chaining holds would need real
      // position-stacking logic to look right, not worth it for the payoff.
      if (target.heldBy !== null || target.holding !== null) continue;
      const dx = target.x - pusher.x;
      const dz = target.z - pusher.z;
      const dist = Math.hypot(dx, dz);
      if (dist > GRAB_RANGE || dist < 0.0001) continue;
      if (dist < closestDist) {
        closestDist = dist;
        closest = target;
      }
    }
    if (!closest) return;

    pusher.lastGrabTime = now;
    pusher.holding = closest.id;
    closest.heldBy = id;
    closest.grabbedAt = now;
    this.io.emit('grabbed', { holderId: id, targetId: closest.id });
  }

  // Pressing shove while holding someone throws them instead — see
  // handleShove, which routes here before any of its normal power-tier
  // logic runs. Direction is the holder's current facing (same forward-
  // vector convention as spawnPoint: (sin(rotY), cos(rotY))), so the throw
  // goes wherever the holder is looking, not toward the target (there is
  // no "target" distinct from the person already overhead).
  throwHeldPlayer(holderId) {
    const holder = this.players.get(holderId);
    if (!holder || holder.holding === null) return;
    const targetId = holder.holding;
    const target = this.players.get(targetId);
    holder.holding = null;
    if (!target) return; // held player vanished (disconnected) mid-hold
    target.heldBy = null;

    // Not gated on SHOVE_COOLDOWN_MS on the way in — a throw is a
    // deliberate release of an already-committed grab and must never be
    // blocked by an unrelated shove's cooldown — but it still refreshes
    // the shared cooldown so a normal shove can't immediately follow it
    // for free.
    holder.lastShoveTime = Date.now();

    const dirX = Math.sin(holder.rotY);
    const dirZ = Math.cos(holder.rotY);

    this.io.emit('shoveAction', { playerId: holderId, power: 'throw' });
    this.io.emit('shoveHit', {
      sourceId: holderId,
      targetId,
      dirX, dirZ,
      force: THROW_FORCE,
      upForce: THROW_UP_FORCE,
      power: 'throw'
    });
    this.io.emit('released', { holderId, targetId, thrown: true });
  }

  // Ends a hold WITHOUT a throw: the HOLD_MAX_MS timeout, or the holder
  // losing control (shoved by someone else, eliminated, disconnected).
  // Looked up by holderId rather than targetId since that's what every
  // call site naturally has on hand; falls back to a scan if the holder
  // itself is already gone so a captive is never left stuck.
  dropHeld(holderId) {
    const holder = this.players.get(holderId);
    let target = null;
    if (holder && holder.holding !== null) {
      target = this.players.get(holder.holding);
      holder.holding = null;
    } else {
      for (const p of this.players.values()) {
        if (p.heldBy === holderId) { target = p; break; }
      }
    }
    if (!target) return;
    target.heldBy = null;

    // Random direction, gentle force — reads as "oops, dropped", not "hit".
    const angle = Math.random() * Math.PI * 2;
    this.io.emit('shoveHit', {
      sourceId: holderId,
      targetId: target.id,
      dirX: Math.cos(angle),
      dirZ: Math.sin(angle),
      force: DROP_FORCE,
      upForce: DROP_UP_FORCE,
      power: 'drop'
    });
    this.io.emit('released', { holderId, targetId: target.id, thrown: false });
  }

  // power: 'normal' | 'charged' | 'special'. 'charged' is a 2s-hold shove
  // (see CHARGE_HOLD_MS on the client) that hits harder and, on landing,
  // advances the pusher's combo toward a 'special' (a two-legged kick,
  // unlocked after SPECIAL_POWER_THRESHOLD charged hits land) — see
  // client/src/main.js for the input/UI side of both.
  handleShove(id, power = 'normal') {
    const pusher = this.players.get(id);
    // heldBy !== null: dangling overhead in someone else's grip is no
    // position to be throwing punches from — mirrors handleGrab's own
    // "can't act while held" guard.
    if (!pusher || !pusher.alive || !this.roundActive || pusher.heldBy !== null) return;

    // Holding someone converts ANY shove input into a throw, regardless of
    // the requested power tier — the 2s-charge flow doesn't make sense
    // while your hands are already full, so pressing shove just
    // immediately unleashes the throw instead. See throwHeldPlayer.
    if (pusher.holding !== null) {
      this.throwHeldPlayer(id);
      return;
    }

    // Guards against a stale/forged 'special' request from a client whose
    // combo the server never actually completed.
    if (power === 'special' && !pusher.specialReady) return;

    const now = Date.now();
    if (now - pusher.lastShoveTime < SHOVE_COOLDOWN_MS) return;
    pusher.lastShoveTime = now;

    if (power === 'special') {
      pusher.specialReady = false;
      pusher.chargedHitStreak = 0;
      this.io.to(id).emit('specialProgress', { count: 0, threshold: SPECIAL_POWER_THRESHOLD, ready: false });
    }

    this.io.emit('shoveAction', { playerId: id, power });

    const range = power === 'special' ? SPECIAL_KICK_RANGE : SHOVE_RANGE;
    const force = power === 'special' ? SPECIAL_KICK_FORCE : power === 'charged' ? CHARGED_SHOVE_FORCE : SHOVE_FORCE;
    const upForce = power === 'special' ? SPECIAL_KICK_UP_FORCE : power === 'charged' ? CHARGED_SHOVE_UP_FORCE : SHOVE_UP_FORCE;

    // Omnidirectional: any alive player within range gets pushed away from
    // the pusher, no facing/cone requirement. Simpler and more forgiving —
    // matches classic sumo "get close and shove" play instead of requiring
    // precise aim. Held players are excluded: their (x, z) is forced to
    // exactly match their holder's every tick (see updateHeldPlayers), so
    // without this exclusion a shove landing on the holder would ALSO
    // independently "hit" whoever they're carrying (same 2D position, same
    // distance-to-pusher) on top of the drop that already fires when the
    // holder gets hit — a suspended captive isn't a separate target.
    let hitAny = false;
    // Drops are deferred until after this loop finishes, not fired inline
    // per-target: dropHeld() mutates the dropped player's own heldBy field
    // as a side effect, and since this loop's own exclusion check above
    // reads that same field, mutating it mid-iteration could make a later-
    // iterated captive incorrectly stop being excluded (their heldBy looks
    // already-cleared by the time their own turn comes up) and get hit
    // twice in the same shove — once via their holder's drop, once as a
    // seemingly-independent target at the same coincident position.
    const holdersToDrop = [];
    for (const target of this.players.values()) {
      if (target.id === id || !target.alive || target.heldBy !== null) continue;
      const dx = target.x - pusher.x;
      const dz = target.z - pusher.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range || dist < 0.0001) continue;
      hitAny = true;

      const ndx = dx / dist;
      const ndz = dz / dist;

      this.io.emit('shoveHit', {
        sourceId: id,
        targetId: target.id,
        dirX: ndx,
        dirZ: ndz,
        force,
        upForce,
        power
      });

      // Getting knocked breaks your grip — losing control of yourself
      // means losing control of whoever you were holding too.
      if (target.holding !== null) holdersToDrop.push(target.id);
    }
    for (const holderId of holdersToDrop) this.dropHeld(holderId);

    // Only a successful (landed) charged shove counts toward the combo —
    // charging and whiffing doesn't build it, but it doesn't reset it
    // either, so a miss just costs the 2s wind-up rather than the streak.
    if (power === 'charged' && hitAny) {
      pusher.chargedHitStreak += 1;
      if (pusher.chargedHitStreak >= SPECIAL_POWER_THRESHOLD) {
        pusher.chargedHitStreak = 0;
        pusher.specialReady = true;
      }
      this.io.to(id).emit('specialProgress', {
        count: pusher.specialReady ? SPECIAL_POWER_THRESHOLD : pusher.chargedHitStreak,
        threshold: SPECIAL_POWER_THRESHOLD,
        ready: pusher.specialReady
      });
    }
  }

  resolveCollisions() {
    // Held players sit exactly at their holder's (x, z) — excluding them
    // here isn't just an optimization: without it, a third player bumping
    // into the holder would resolve against both the holder AND the
    // coincident held player as if two separate bodies occupied that spot,
    // effectively doubling the holder's push-back for no physical reason.
    const alive = [...this.players.values()].filter(p => p.alive && p.heldBy === null);
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
      const { x, z, rotY } = this.spawnPoint(index++, this.players.size);
      player.x = x;
      player.y = 0;
      player.z = z;
      player.rotY = rotY;
      player.alive = true;
      // Fresh round, fresh combo — a special earned last round shouldn't
      // carry over as a surprise opening move.
      player.chargedHitStreak = 0;
      player.specialReady = false;
      // Fresh round, no lingering grab either — respawning everyone at
      // spawn points would otherwise leave a held player's heldBy pointing
      // at a holder who just teleported away.
      player.heldBy = null;
      player.holding = null;
      this.io.to(player.id).emit('specialProgress', { count: 0, threshold: SPECIAL_POWER_THRESHOLD, ready: false });
    }
    this.roundActive = true;
    this.io.emit('roundStart', { map: this.serializeMap(), players: this.serializeAll() });
  }

  // Every held player gets teleported to just above their holder each
  // tick — this IS their position while held, not a physics simulation,
  // so it always wins regardless of whatever resolveCollisions() did to
  // them earlier in the same tick (called first in tick(), see below).
  updateHeldPlayers() {
    const now = Date.now();
    for (const player of this.players.values()) {
      if (player.heldBy === null) continue;
      // Shouldn't normally happen (a held player's own moves are ignored
      // and their y is forced above ELIMINATION_Y every tick), but guard
      // against a dead player being left floating in someone's arms.
      if (!player.alive) { this.dropHeld(player.heldBy); continue; }

      const holder = this.players.get(player.heldBy);
      if (!holder || !holder.alive || now - player.grabbedAt > HOLD_MAX_MS) {
        this.dropHeld(player.heldBy);
        continue;
      }

      player.x = holder.x;
      player.y = holder.y + HELD_OFFSET_Y;
      player.z = holder.z;
      // Facing follows the holder too, so the carried player visually
      // faces the same way as whoever's carrying them instead of staying
      // frozen at whatever angle they were grabbed from.
      player.rotY = holder.rotY;
    }
  }

  tick() {
    if (this.roundActive) {
      this.resolveCollisions();
      this.checkEliminations();
      this.updateHeldPlayers();
    }
    this.io.emit('state', { players: this.serializeAll() });
  }

  serializePlayer(p) {
    return {
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, z: p.z, rotY: p.rotY,
      alive: p.alive,
      // State-driven, like `alive` — clients derive isHeld/isHolding from
      // this every state broadcast rather than only trusting the one-shot
      // 'grabbed'/'released' events, so a dropped packet can't leave a
      // client stuck thinking someone is still held.
      heldBy: p.heldBy, holding: p.holding
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
      emissiveGround, decoration, liquidColor, liquidGlow
    } = this.map;
    return {
      id, name, radius, spawnRadius, height,
      groundColor, ringColor, voidColor, skyColor,
      lightColor, lightIntensity, ambientColor,
      emissiveGround, decoration, liquidColor, liquidGlow
    };
  }

  start() {
    setInterval(() => this.tick(), 1000 / TICK_RATE_HZ);
  }
}
