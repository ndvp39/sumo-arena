import {
  PLAYER_RADIUS, ELIMINATION_Y,
  SHOVE_RANGE, SHOVE_FORCE, SHOVE_UP_FORCE, SHOVE_COOLDOWN_MS, KILL_ATTRIBUTION_MS,
  CHARGED_SHOVE_FORCE, CHARGED_SHOVE_UP_FORCE,
  SPECIAL_POWER_THRESHOLD, SPECIAL_KICK_RANGE, SPECIAL_KICK_FORCE, SPECIAL_KICK_UP_FORCE,
  GRAB_RANGE, GRAB_COOLDOWN_MS, HELD_OFFSET_Y, HOLD_MAX_MS,
  THROW_FORCE, THROW_UP_FORCE, DROP_FORCE, DROP_UP_FORCE,
  MOMENTUM_MAX_TRACKED_SPEED, MOMENTUM_MAX_TRACKED_FALL_SPEED,
  MOMENTUM_SPEED_BONUS_PER_UNIT, MOMENTUM_FALL_BONUS_PER_UNIT, MOMENTUM_MAX_MULTIPLIER,
  MOMENTUM_GRAB_RANGE_BONUS_PER_UNIT, MOMENTUM_GRAB_RANGE_MAX_MULTIPLIER,
  HAZARD_INTERVAL_MIN_MS, HAZARD_INTERVAL_MAX_MS, HAZARD_WARNING_MS, HAZARD_RADIUS,
  HAZARD_FORCE, HAZARD_UP_FORCE,
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
    // Volcano Pit's fireball hazard: null on any map without the 'fireball'
    // hazard key, or the next real-time eruption timestamp otherwise. See
    // scheduleNextHazard.
    this.nextHazardAt = null;
    this.scheduleNextHazard();
  }

  // Picks a fresh, randomized eruption time if the current map has the
  // 'fireball' hazard, or clears it entirely otherwise. Called on
  // construction and every restartRound() map swap, so a map with no
  // hazard never ticks toward one it could never fire, and switching INTO
  // a hazard map always starts its timer fresh rather than reusing
  // whatever the previous map happened to leave behind.
  scheduleNextHazard() {
    if (this.map.hazard !== 'fireball') {
      this.nextHazardAt = null;
      return;
    }
    const delay = HAZARD_INTERVAL_MIN_MS + Math.random() * (HAZARD_INTERVAL_MAX_MS - HAZARD_INTERVAL_MIN_MS);
    this.nextHazardAt = Date.now() + delay;
  }

  // Warns everyone at a random point on the platform, then (after
  // HAZARD_WARNING_MS) actually erupts there — see hazardErupt. Re-arms the
  // timer immediately rather than after the eruption resolves, so a warning
  // that never gets to erupt (round ends first, see hazardErupt's own
  // guard) can't leave the schedule stuck.
  triggerHazardWarning() {
    const angle = Math.random() * Math.PI * 2;
    // Up to 85% of the platform radius — comfortably inside the boundary,
    // and not so tight to center that every eruption lands in the one spot
    // players are already avoiding by default.
    const dist = Math.random() * this.map.radius * 0.85;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;

    this.io.emit('hazardWarning', { x, z, warningMs: HAZARD_WARNING_MS });
    this.scheduleNextHazard();
    setTimeout(() => this.hazardErupt(x, z), HAZARD_WARNING_MS);
  }

  // The actual eruption: hits every alive, non-held player within
  // HAZARD_RADIUS with a shoveHit-shaped knockback (sourceId null, power
  // 'hazard', since no player threw this) radiating outward from (x, z).
  // Mirrors handleShove's own hit loop, including the deferred-drop pattern
  // for anyone caught mid-hold.
  hazardErupt(x, z) {
    // The round can end (but not yet restart — see the comment on tick()'s
    // hazard check) in the HAZARD_WARNING_MS between the warning and this
    // firing; a stale eruption from an already-over round must not still
    // hit anyone once a new one starts.
    if (!this.roundActive) return;

    this.io.emit('hazardTrigger', { x, z });

    const holdersToDrop = [];
    for (const target of this.players.values()) {
      if (!target.alive || target.heldBy !== null) continue;
      const dx = target.x - x;
      const dz = target.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > HAZARD_RADIUS) continue;

      // Same normalize-and-push-outward pattern as handleShove's hit loop;
      // standing exactly on the eruption point (dist ~ 0) picks a random
      // direction instead, since dx/dz would otherwise both be ~0.
      let ndx, ndz;
      if (dist < 0.0001) {
        const a = Math.random() * Math.PI * 2;
        ndx = Math.cos(a);
        ndz = Math.sin(a);
      } else {
        ndx = dx / dist;
        ndz = dz / dist;
      }

      this.io.emit('shoveHit', {
        sourceId: null,
        targetId: target.id,
        dirX: ndx,
        dirZ: ndz,
        force: HAZARD_FORCE,
        upForce: HAZARD_UP_FORCE,
        power: 'hazard'
      });
      // 'hazard' sentinel (not a real player id) so checkEliminations still
      // credits a fall shortly after this as attributable — this.players.get
      // on it safely resolves to undefined (no killer), but lastHitPower
      // still correctly reads 'hazard' on the resulting playerEliminated
      // event instead of null, distinguishing "the volcano got them" from
      // an unassisted fall.
      target.lastHitBy = 'hazard';
      target.lastHitPower = 'hazard';
      target.lastHitAt = Date.now();

      if (target.holding !== null) holdersToDrop.push(target.id);
    }
    for (const holderId of holdersToDrop) this.dropHeld(holderId);
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
      // Kills landed by this player in the CURRENT round only, reset every
      // restartRound() — drives the client's combo/streak text (2+ in a
      // row without dying gets called out), not a lifetime/session stat.
      killsThisRound: 0,
      // Grab/throw: heldBy is the id of whoever is holding THIS player (or
      // null); holding is the id of whoever THIS player is holding (or
      // null). At most one of a player's own {holding, heldBy} pair is ever
      // meaningfully "active" at once — you can't hold someone while being
      // held yourself (see handleGrab).
      heldBy: null,
      holding: null,
      lastGrabTime: 0,
      grabbedAt: 0,
      // Momentum: derived from real position deltas in updateFromClient,
      // never trusted directly from the client — see getMomentumMultiplier.
      // lastReported* is deliberately separate from x/y/z: resolveCollisions
      // mutates x/z directly every tick (30Hz) to push overlapping players
      // apart, completely independent of when 'move' packets arrive. Using
      // x/z as the "previous position" reference for velocity would mean
      // getting close enough to shove someone — which is also often close
      // enough to overlap them, since SHOVE_RANGE is generous relative to
      // the collision radius — silently corrupts the very momentum signal
      // combat is supposed to reward, right when it matters most.
      speed: 0,
      vertSpeed: 0,
      lastMoveTime: 0,
      lastReportedX: x,
      lastReportedY: 0,
      lastReportedZ: z,
      // Kill attribution for the client's feed (see checkEliminations):
      // who last landed a real hit on this player, with what, and when —
      // "when" matters so an old hit from ages ago doesn't get wrongly
      // blamed for an unrelated later fall (see KILL_ATTRIBUTION_MS).
      lastHitBy: null,
      lastHitPower: null,
      lastHitAt: 0
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
    // ignoring a dead player's moves. Also ignore anything received while
    // the round itself isn't active (the post-roundOver freeze before
    // restartRound runs): a player who's still alive but mid-fall the
    // instant the round ends — because the last OTHER player was
    // eliminated first — never gets their own `alive` flipped false,
    // since checkEliminations stops running the moment roundActive does
    // (see tick()). Without this guard they'd keep freely streaming an
    // ever-more-negative Y for the whole restart delay, and a stale
    // in-flight packet landing right after restartRound() resets everyone
    // to spawn would snap them straight back into "still falling"
    // territory and instantly re-eliminate them in the new round — the
    // same failure mode a prior fix already solved for an actually-dead
    // player (see PLAN.md), just reachable here through a path where the
    // player is never marked dead at all.
    if (!player || !player.alive || player.heldBy !== null || !this.roundActive) return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;

    // Derive real velocity from how far they actually moved since their
    // last update, using lastReported* (their own last self-reported spot,
    // NOT player.x/z — see the field comment in addPlayer for why that
    // distinction matters) as the "previous position". This is what
    // getMomentumMultiplier reads for combat, and deriving it from trusted
    // position history (rather than accepting a client-reported speed
    // value) means it can't be forged by just claiming a big number; the
    // only way to raise it is to actually cover ground that fast.
    const now = Date.now();
    const dt = (now - player.lastMoveTime) / 1000;
    // Skip the very first update (lastMoveTime is 0, so dt would be huge)
    // and any implausibly large gap (a lag spike or a respawn teleport) —
    // both would otherwise register as a momentary "infinite speed" burst.
    if (player.lastMoveTime > 0 && dt > 0.001 && dt < 1) {
      const dx = data.x - player.lastReportedX;
      const dz = data.z - player.lastReportedZ;
      const dy = data.y - player.lastReportedY;
      player.speed = Math.min(MOMENTUM_MAX_TRACKED_SPEED, Math.hypot(dx, dz) / dt);
      player.vertSpeed = Math.max(-MOMENTUM_MAX_TRACKED_FALL_SPEED, Math.min(MOMENTUM_MAX_TRACKED_FALL_SPEED, dy / dt));
    }
    player.lastMoveTime = now;
    player.lastReportedX = data.x;
    player.lastReportedY = data.y;
    player.lastReportedZ = data.z;

    // Trust client-simulated transform; server still validates boundary/collision each tick.
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.rotY = data.rotY || 0;
  }

  // Real momentum, real payoff: a shove/kick/throw hits harder the faster
  // the attacker was actually moving (running, sprinting, or falling) the
  // instant they threw it. Falling counts too (vertSpeed < 0), so a
  // mid-air shove/throw while still dropping from a jump lands bigger —
  // matches the existing "jump+shove already works" design (see PLAN.md
  // §11) with actual weight behind it now instead of just being allowed.
  getMomentumMultiplier(player) {
    const fallBonus = player.vertSpeed < 0 ? -player.vertSpeed * MOMENTUM_FALL_BONUS_PER_UNIT : 0;
    const speedBonus = player.speed * MOMENTUM_SPEED_BONUS_PER_UNIT;
    return Math.min(MOMENTUM_MAX_MULTIPLIER, 1 + speedBonus + fallBonus);
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

    // Broadcast the attempt itself, unconditionally, the same way
    // handleShove announces 'shoveAction' before it knows whether anything
    // is actually in range — the reaching-for-someone lunge (see
    // client/src/avatar.js's 'grab' animation) is feedback that a grab was
    // tried, not confirmation that it landed; a whiff still shows the
    // attempt, exactly like a whiffed shove still shows the swing.
    this.io.emit('grabAction', { playerId: id });

    // A fast-moving grab reaches a bit further — reads as a diving/lunging
    // tackle rather than a bigger hit, since a grab has no "force" of its
    // own to scale.
    const effectiveGrabRange = GRAB_RANGE * Math.min(
      MOMENTUM_GRAB_RANGE_MAX_MULTIPLIER,
      1 + pusher.speed * MOMENTUM_GRAB_RANGE_BONUS_PER_UNIT
    );

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
      if (dist > effectiveGrabRange || dist < 0.0001) continue;
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
    // While held, target.x/y/z was teleported to the holder every tick
    // (see updateHeldPlayers) but target's OWN lastReported* was frozen at
    // wherever they were the instant they got grabbed, since their move
    // packets are ignored the whole time they're held. Without this reset,
    // their first move packet after release would measure a delta against
    // that stale pre-grab spot instead of the real release point, reading
    // as a brief false "teleport speed" burst.
    target.lastReportedX = target.x;
    target.lastReportedY = target.y;
    target.lastReportedZ = target.z;

    // Not gated on SHOVE_COOLDOWN_MS on the way in — a throw is a
    // deliberate release of an already-committed grab and must never be
    // blocked by an unrelated shove's cooldown — but it still refreshes
    // the shared cooldown so a normal shove can't immediately follow it
    // for free.
    holder.lastShoveTime = Date.now();

    const dirX = Math.sin(holder.rotY);
    const dirZ = Math.cos(holder.rotY);
    // A holder who sprinted (or jumped) into the throw sends their captive
    // flying noticeably further — same momentum system as a shove. Unlike
    // every other power tier, though, a throw is real ballistic flight
    // (see client/src/player.js's knockbackBallistic) where the vertical
    // component directly controls how long — and therefore how far — the
    // flight lasts. Applying the full momentum multiplier to BOTH
    // components would make a fast throw balloon into an unrealistically
    // tall arc; real momentum from a sprint/fall should mostly show up as
    // covering more ground, not launching higher, so only half the bonus
    // reaches the vertical component here.
    const momentum = this.getMomentumMultiplier(holder);
    const upMomentum = 1 + (momentum - 1) * 0.5;

    this.io.emit('shoveAction', { playerId: holderId, power: 'throw' });
    this.io.emit('shoveHit', {
      sourceId: holderId,
      targetId,
      dirX, dirZ,
      force: THROW_FORCE * momentum,
      upForce: THROW_UP_FORCE * upMomentum,
      power: 'throw'
    });
    target.lastHitBy = holderId;
    target.lastHitPower = 'throw';
    target.lastHitAt = Date.now();
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
    // Same stale-reference fix as throwHeldPlayer — see its comment.
    target.lastReportedX = target.x;
    target.lastReportedY = target.y;
    target.lastReportedZ = target.z;

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
    const baseForce = power === 'special' ? SPECIAL_KICK_FORCE : power === 'charged' ? CHARGED_SHOVE_FORCE : SHOVE_FORCE;
    const baseUpForce = power === 'special' ? SPECIAL_KICK_UP_FORCE : power === 'charged' ? CHARGED_SHOVE_UP_FORCE : SHOVE_UP_FORCE;
    // Running, sprinting, or still falling from a jump when the shove
    // lands all make it hit harder — same system as a throw's momentum.
    const momentum = this.getMomentumMultiplier(pusher);
    const force = baseForce * momentum;
    const upForce = baseUpForce * momentum;

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
      target.lastHitBy = id;
      target.lastHitPower = power;
      target.lastHitAt = Date.now();

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
        // Attribute to whoever hit them last, but only if that hit is
        // recent enough (KILL_ATTRIBUTION_MS) — otherwise this reads as an
        // unassisted fall, not a kill some hit from ages ago gets wrongly
        // credited for. The killer may have disconnected since; killerName
        // is captured here (not looked up client-side) so the feed still
        // reads correctly even if they're already gone by the time this
        // arrives.
        const recentHit = player.lastHitBy && (Date.now() - player.lastHitAt < KILL_ATTRIBUTION_MS);
        const killer = recentHit ? this.players.get(player.lastHitBy) : null;
        // Combo/streak text: counts kills landed by the same player without
        // dying in between (checked here, once per elimination, rather than
        // wherever a hit lands) so it only ever advances on an actual kill,
        // never on a hit that merely knocks someone around.
        if (killer) killer.killsThisRound += 1;
        this.io.emit('playerEliminated', {
          id: player.id,
          name: player.name,
          killerId: killer ? killer.id : null,
          killerName: killer ? killer.name : null,
          power: recentHit ? player.lastHitPower : null,
          killerKillCount: killer ? killer.killsThisRound : null
        });
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
    // Re-roll (or clear, if the new map has no hazard) against the map that
    // was just picked, not whatever the previous one had scheduled.
    this.scheduleNextHazard();

    let index = 0;
    for (const player of this.players.values()) {
      const { x, z, rotY } = this.spawnPoint(index++, this.players.size);
      player.x = x;
      player.y = 0;
      player.z = z;
      player.rotY = rotY;
      player.alive = true;
      // Respawning is a teleport — without resetting these too, the next
      // move packet's delta would be measured against the pre-respawn
      // spot, reading as a brief (if harmless) momentary "max speed" burst.
      player.lastReportedX = x;
      player.lastReportedY = 0;
      player.lastReportedZ = z;
      // Fresh round, fresh combo — a special earned last round shouldn't
      // carry over as a surprise opening move.
      player.chargedHitStreak = 0;
      player.specialReady = false;
      // Fresh round, fresh combo/streak count too — a rampage last round
      // shouldn't carry a phantom head start into the next one.
      player.killsThisRound = 0;
      // Fresh round, no stale kill attribution either.
      player.lastHitBy = null;
      player.lastHitPower = null;
      player.lastHitAt = 0;
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
      // Gated on roundActive so a hazard warning can never START outside an
      // active round — combined with hazardErupt's own roundActive guard,
      // that means a hazard already in flight when a round ends is the only
      // way one can ever fail to erupt, never one starting fresh mid-break.
      if (this.nextHazardAt !== null && Date.now() >= this.nextHazardAt) {
        this.triggerHazardWarning();
      }
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
