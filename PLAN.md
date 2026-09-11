# Sumo Arena — Master Plan

Real-time 3D multiplayer browser Sumo game. Players move around a circular
arena with WASD, jump with SPACE, and shove opponents with F. Last player
standing wins.

## 1. Architecture

Two independent npm projects, run together via a root `concurrently` script.

- `server/` — Node + Express + Socket.io. Authoritative for game rules.
- `client/` — Vite + Three.js. Renders the scene and predicts local movement.

Networking model:
- **Client-predicted movement** — each client simulates its own WASD
  movement, gravity and jump locally (instant, no input lag) and streams its
  transform to the server ~20×/sec.
- **Server-authoritative everything else** — arena boundary/elimination
  checks, player-vs-player collision resolution, shove range detection,
  knockback outcomes, round win/reset, map rotation. State is broadcast to
  all clients at 30Hz.
- **Remote players are interpolated** — each client lerps other players'
  rendered position/rotation toward the latest server snapshot so movement
  looks smooth despite discrete network updates, instead of teleporting/
  stuttering between packets.

## 2. Project structure

```
onlinegame/
  package.json                # root: `npm run dev` starts server + client together
  server/
    package.json
    server.js                 # Express + Socket.io wiring, connection handlers
    constants.js               # gravity, shove force/range/cooldown, tick rate...
    maps.js                    # map registry (radius, spawn ring, colors)
    GameRoom.js                 # authoritative state: players, collisions, elimination, round/map lifecycle
  client/
    package.json
    vite.config.js
    index.html                  # canvas + name-entry overlay + HUD + banner
    src/
      constants.js              # movement/jump/shove tuning, mirrors server values
      network.js                 # socket.io-client wrapper, typed event callbacks
      avatar.js                  # composite human avatar + name sprite + punch/fall animation
      scene.js                   # renderer/camera/lighting + dynamic arena builder
      player.js                  # local player controller: movement, gravity/jump, facing, shove, knockback
      remotePlayers.js            # manages other players' avatars + interpolation + remote anims
      main.js                     # entry point: login flow, game loop, wires everything together
```

## 3. Character design

Each player is a composite of primitive Three.js geometries (no external
models/rigs, per the brief):

- Head: `SphereGeometry`
- Torso: `BoxGeometry`
- Arms: `BoxGeometry`, each parented to a shoulder **pivot group** so it can
  swing forward independently — used for the shove animation
- Legs: `BoxGeometry` ×2
- Name label: a `THREE.Sprite` built from a canvas-rendered text texture,
  floating above the head, always facing the camera

Player color is assigned server-side from a fixed palette (by join order) so
every client renders the same player in the same color.

## 4. Controls & actions

Standard third-person mouse-look scheme (revised from the original
world-fixed-axis WASD after playtesting — see §9):

| Input | Effect |
|---|---|
| Mouse (after clicking the arena to lock the pointer) | Orbits the camera around the player — yaw (left/right) and pitch (up/down, inverted per preference). Pure camera control; does not touch movement or gameplay. |
| W / A / S / D | Move **relative to the camera**: W = into the current view, S = back out of it, A/D = strafe screen-left/right. Diagonals (e.g. W+D) work naturally since each key is an independent held-state, not mutually exclusive. |
| SPACE | Jump (applies upward velocity, gravity pulls back down, grounded check). Can be pressed while moving. |
| F | Shove: swings both arms forward, asks server to push any opponent within range — omnidirectional, no aiming required (see §9). Can be pressed while moving or jumping. |

The avatar's own facing is **decoupled from the camera** — it turns to face
whichever direction it's actually moving (cosmetic only, computed from the
movement vector), while the camera keeps whatever yaw/pitch the mouse set,
independent of that. This means looking around never fights with walking.

Local physics loop each frame: resolve WASD into a world-space direction
using the camera's yaw, apply gravity to vertical velocity, integrate
position, clamp to ground plane, set `grounded`. Movement and jump are fully
client-side for responsiveness; the server does not recompute them, only
validates their consequences (see below).

## 5. Physics & game rules (server-authoritative)

- **Boundary detection** — each tick, compare each alive player's distance
  from arena center to the current map's radius; outside it (and airborne
  below a height threshold) or fallen below a Y floor → eliminated.
- **Player-to-player collision** — each tick, pairwise circle-overlap check
  among alive players; overlapping pairs are pushed apart symmetrically along
  the vector between them.
- **Knockback** — on a shove hit (any alive player within `SHOVE_RANGE`
  of the pusher — omnidirectional, no facing/cone check, see §9), server
  computes a direction away from the pusher and broadcasts a `shoveHit`
  impulse; the *target's own client* applies that impulse to its local
  physics (decaying over ~0.4s) and streams the resulting position back, so
  everyone else sees it arrive via normal state interpolation.
- **Elimination & round flow** — when only one (or zero) player remains alive
  and at least 2 total players are in the room, broadcast `roundOver`
  (including `restartInMs`, the fixed 5s delay, so clients can show a
  countdown — see §9), wait that long, then reset all players to fresh spawn
  points on the next map in rotation and broadcast `roundStart`.
- **Falling is a real fall, not an instant boundary trip.** The client only
  clamps a player to ground level while they're actually over the platform
  (`distFromCenter <= arenaRadius`, checked in `player.js` each frame); step
  past the ring edge and gravity just keeps pulling down with nothing to
  land on. The server doesn't eliminate on boundary-crossing at all anymore
  — only once you've fallen deep enough (`ELIMINATION_Y = -14`, ~1.2s of
  falling), so going out feels like actually falling into the void instead
  of vanishing the instant you cross the line.

## 6. Maps (built for extensibility)

`server/maps.js` holds a registry of arena configs:

```js
{
  id, name, radius, spawnRadius, height,
  groundColor, ringColor, voidColor,
  skyColor, lightColor, lightIntensity, ambientColor,
  emissiveGround, decoration
}
```

`GameRoom` reads `this.map` for every radius-dependent rule (elimination
check, spawn positions). The client has **no hardcoded arena** — `scene.js`
builds/rebuilds the platform mesh, sky, light tint, and themed decorations
purely from whatever map object the server sends (on `init` when joining,
and on `roundStart` when the map changes).

The room round-robins through `MAP_ROTATION` after every round. **Adding a
new map is just adding one entry to the registry and (optionally) to the
rotation array** — no client changes required, since geometry/colors/theme
are all data-driven.

**Visual theming**, added in the playtesting pass (§9): each map also
carries a gradient sky (`skyColor` at the top fading to `voidColor` at the
horizon, built as a small canvas texture — `scene.js#_buildSkyTexture`), a
tint for the sun/ambient/fill lights (`lightColor`, `lightIntensity`,
`ambientColor`), an optional glowing floor (`emissiveGround`), and a
`decoration` key selecting a themed prop-builder in
`scene.js#_buildDecorations` — all primitive-geometry props (cones,
cylinders, points), no external assets, arranged in a ring just outside the
boundary.

Ships with **9 maps**, each a distinct subject:

| Map | Subject | Decoration theme |
|---|---|---|
| Classic Dohyo | Traditional sumo ring | `dohyo` — 4 wooden corner posts with flags |
| Small Ring | Tighter, higher-stakes | `dohyo` |
| Grand Arena | Large sci-fi arena | `pillars` — glowing cyan pillars |
| Volcano Pit | Molten rock arena | `lava` — jagged spikes + glowing lava pools |
| Frozen Wastes | Arctic ice field | `ice` — translucent crystal spikes |
| Neon Grid | Cyberpunk grid floor | `neon` — neon grid overlay + glowing pylons |
| Desert Mesa | Sun-baked desert | `desert` — rock formations + cacti |
| Deep Space Station | Zero-atmosphere void | `space` — starfield + drifting asteroids |
| Sky Temple Ruins | Ancient ruins adrift in a sunset sky | `skytemple` — broken mossy pillars, floating rock islands, drifting golden sparkles |

## 7. Real-time synchronization

- `join` → server assigns spawn point, color, sends `init` (self id, map,
  full player list) to the joining client, and `playerJoined` to everyone
  else.
- `move` → client streams its transform ~20Hz; server stores it (trusted for
  position, validated for game rules).
- `shove` → server validates cooldown/range (omnidirectional, see §9),
  broadcasts `shoveAction` (animation, all clients) and `shoveHit`
  (knockback, target only acts on it).
- `state` → full snapshot broadcast at 30Hz; drives remote-player
  interpolation and HUD alive-count.
- `playerEliminated`, `roundOver` (carries `restartInMs` — drives the
  client's restart countdown banner, see §9), `roundStart`, `playerLeft`,
  `disconnect` → lifecycle events for HUD banners and cleanup.

## 8. Build order (execution checklist)

- [x] Root `package.json` (concurrently dev script)
- [x] `server/package.json`, `constants.js`, `maps.js`, `GameRoom.js`, `server.js`
- [x] `client/package.json`, `vite.config.js`, `index.html`
- [x] `client/src/constants.js`, `network.js`, `avatar.js`
- [x] `client/src/scene.js` — renderer, camera, lighting, dynamic arena builder
- [x] `client/src/player.js` — local movement/jump/shove/knockback controller
- [x] `client/src/remotePlayers.js` — remote avatar management + interpolation
- [x] `client/src/main.js` — login flow, game loop, event wiring, HUD
- [x] `npm install` in both packages
- [x] Smoke test: server health/maps/socket.io endpoints and all client modules verified serving correctly

## 9. Playtesting fixes (post-launch)

The build above ran, but real play (and a headless-browser test harness
driving two clients at once via Playwright + a raw Socket.io "observer"
client for ground-truth state) surfaced issues the smoke test didn't catch.
Each was reproduced before fixing, then re-verified.

1. **Spawn-facing bug.** `GameRoom.spawnPoint()` set
   `rotY = angle + PI`, which doesn't match the forward-vector convention
   used everywhere else (`forward = (sin(rotY), cos(rotY))`). Players
   spawned facing a direction unrelated to the arena center, so with only 2
   players neither one was looking at the other. Fixed to
   `rotY = atan2(-x, -z)` (face the center), in `server/GameRoom.js`.

2. **Shove had a facing-cone requirement that felt broken.** Originally a
   shove only landed if the target was within a ~70° cone in front of the
   pusher (`SHOVE_CONE_DOT`). Standing right next to someone but facing
   slightly the wrong way silently did nothing — confusing, especially once
   the camera no longer visibly tracked the avatar's facing. Removed the
   cone check entirely: shove is now **omnidirectional**, any alive player
   within range gets pushed away from the pusher. Matches classic "get
   close and shove" sumo play.

3. **Shove range was too tight.** `SHOVE_RANGE` raised from `1.9` to `2.6`
   — reach is measured center-to-center, and the pusher's own server-side
   position can lag their true position by up to one network tick (~50ms at
   20Hz) at the moment F is pressed, so a visually-clean hit could still
   read as "too far" server-side.

4. **Camera redesigned twice based on feedback:**
   - First pass: camera was a chase cam that rotated to match the avatar's
     own `rotY`, which was itself derived from whichever direction was last
     moved — so the camera visibly spun every time movement direction
     changed. Disorienting.
   - Final scheme: full third-person **mouse-look** via the Pointer Lock
     API (`client/src/main.js`) — camera yaw/pitch come only from mouse
     movement, `client/src/scene.js#updateCamera` orbits purely on that,
     and movement direction is resolved from WASD *relative to camera yaw*
     in `client/src/player.js`. The avatar's own mesh rotation was then
     decoupled to face movement direction instead of the camera, so
     strafing doesn't visually snap the character to face the camera.
   - Vertical mouse axis inverted per preference (mouse-up now does what
     mouse-down originally did).

5. **Strafe was inverted.** The camera-relative "right" vector had the
   wrong sign — A and D moved the opposite of the intended screen
   direction. Verified against the camera's own `lookAt` basis
   (`right = cross(up, back)`) and fixed in `client/src/player.js`.

6. **Diagonal movement / simultaneous jump+shove** — checked, not actually
   broken: WASD are independent booleans and Space/F handlers don't gate on
   other key state, so W+D diagonals and jumping or shoving mid-walk already
   worked once the above issues were out of the way.

7. **Shove range was still too tight even without the cone.** `SHOVE_RANGE`
   raised again, `1.9` → `2.6` — reach is measured center-to-center, and the
   pusher's own server-side position can lag their true position by up to
   one network tick (~50ms at 20Hz) at the moment F is pressed, so a
   visually-clean hit could still read as "too far" server-side.

## 10. Environments & elimination feel (feature pass)

1. **5 new themed maps added** (Volcano Pit, Frozen Wastes, Neon Grid,
   Desert Mesa, Deep Space Station), each with a distinct sky gradient,
   light tint, and procedural decoration set — see §6 for the full table
   and schema. Verified by forcing a round rotation via a raw-socket test
   client and screenshotting the result: gradient sky, corner-post/flag
   decorations, and lava-spike/pool props all confirmed rendering as
   designed with zero console errors.

2. **Falling now takes real time instead of being instant.** Previously,
   crossing the ring boundary while grounded eliminated a player the same
   tick — there was no actual "falling" to see. Now (§5): the client only
   clamps to ground while over the platform, so stepping off the edge lets
   gravity carry the player down freely, and the server only eliminates once
   they've fallen to `ELIMINATION_Y = -14` (~1.2s). Verified with a
   raw-socket test that streamed a simulated fall and confirmed `alive`
   stayed `true` all the way down to y≈-12.5 and only flipped at y≈-14.5.

3. **Round-restart countdown.** `roundOver` now carries `restartInMs`
   (the server's fixed 5s delay) so everyone can see exactly when the next
   round starts instead of a vague "starting soon" — the client
   (`main.js#startRestartCountdown`) runs a live "Next round in Ns" countdown
   on the banner, ticking down to "Starting..." Verified the payload is
   present and correct via the same raw-socket fall test.

## 11. Jump+shove height report (investigated, not a bug) & smoothness pass

**"Pushing while jumping over a grounded player doesn't work"** — investigated
and disproven. `GameRoom#handleShove` only ever compared horizontal (x, z)
distance; height was never part of the check. Confirmed two ways: (1) an
isolated raw-socket test placing the pusher 2.5 units above the target at
close horizontal range still produced a `shoveHit`; (2) a full end-to-end
browser test with real client-simulated jump physics — pusher airborne at
y≈1.0, target grounded at y=0, 1.0 unit apart — landed a 1.63-unit knockback.
Most likely explanation for what was actually seen: a stale server process
from a restart that silently failed (see the port-ownership note below).

**Server restart reliability (environment note).** Discovered mid-session
that `lsof -ti:3000 | xargs kill` is unreliable on this Windows/Git-Bash
setup — `node ... &`'s reported `$!` isn't the real Windows PID, so the
"restart" sometimes left the old process holding port 3000 while a new,
already-obsolete-by-comparison one crashed with `EADDRINUSE` in the
background. Fixed by cross-checking `netstat -ano | grep :3000` for the
actual owning PID before killing. Worth remembering for any future restart:
verify via `netstat`, not by trusting the backgrounded shell job's PID.

**Smoothness / performance pass**, done proactively on request for a
lag-free feel:
- Decorative props (spikes, pillars, rocks, crystals, posts) no longer cast
  shadows — they added real shadow-pass cost for no visible benefit at their
  size. Player avatars and the platform still do.
- `scene.js#updateCamera` reuses a single `Vector3` instead of allocating a
  new one every frame (60/s), cutting a steady stream of small GC pressure.
- The local player's server-collision correction used to snap 30% of the
  gap toward the authoritative position instantly on every `state` packet
  (~30/s), which read as a jerk. It now stores the target and eases toward
  it every render frame at a fixed, framerate-independent rate
  (`player.js#_easeTowardServerTarget`), so the correction is a smooth glide
  instead of a series of snaps.
- Network tick rates (20Hz client→server, 30Hz server→clients) were left
  as-is — already reasonable for this player count; not worth raising
  without evidence they're the actual bottleneck.

## 12. Shove rework: exact reach, charged hold, and a special combo kick

**Exact-reach fix.** `SHOVE_RANGE` was `2.6`, well past what the avatar's arm
geometry could plausibly cover — shoves were landing on targets that visibly
weren't in arm's reach. Replaced with a value derived directly from the
avatar's own geometry: `SHOVE_RANGE = PLAYER_RADIUS * 2 + ARM_REACH` (`0.5*2 +
0.6 = 1.6`), where `ARM_REACH` mirrors the arm's actual length in
`client/src/avatar.js`. Base force also raised (`SHOVE_FORCE` 11→16,
`SHOVE_UP_FORCE` 3.5→5). Verified with a raw-socket test: a target at
distance 1.5 (within range) took the hit, an otherwise-identical target at
1.8 (within the old range, outside the new one) did not.

**Charged shove (hold 2s).** Holding the shove input — F on desktop, the
SHOVE button on mobile — for `CHARGE_HOLD_MS` (2000ms) fires a much harder
shove (`CHARGED_SHOVE_FORCE`/`CHARGED_SHOVE_UP_FORCE`, ~2x base) instead of a
tap's normal one; releasing early just fires a normal shove. Both input
paths share one state machine in `main.js` (`onShovePress`/`onShoveRelease`/
the per-frame charge tick in `loop()`) — `touchControls.js` only forwards raw
press/release, it doesn't own any timing. Progress renders as a radial
"circle bar": the mobile SHOVE button fills via a `conic-gradient`
(`touchControls.js#setShoveChargeProgress`), desktop gets an equivalent ring
near the bottom of the screen (`#desktopChargeRing`). Landing a charged hit
also pulses a gold emissive glow on the puncher's arms and drops a brief
expanding shockwave ring at the point of impact
(`scene.js#spawnShockwave`/`updateEffects`), visible to every client, not
just the two players involved.

**Special power: two-legged kick.** Landing `SPECIAL_POWER_THRESHOLD` (3)
charged shoves — tracked server-side per player as `chargedHitStreak`, only
incremented on an actual landed hit — unlocks one use of a "special": a
two-legged flying kick (`GameRoom#handleShove` power `'special'`) with a
longer lunge range (`SPECIAL_KICK_RANGE = SHOVE_RANGE + 0.6`) and much
bigger force/upward force than even a charged shove. The server is
authoritative for eligibility (`pusher.specialReady`, reset to false the
moment it's spent or a round restarts) — the client's own gating is
UI-only, purely so the button/prompt doesn't invite a wasted tap.

Progress is pushed to just the earning player via a targeted
`specialProgress` event (`io.to(id).emit(...)`, using each socket's implicit
own-id room) and rendered as an always-visible top-of-screen pip meter
(`#specialMeter`, 3 dots that fill gold as hits land) with a hint line that
switches from "Land N more charged shoves" to a pulsing "SPECIAL READY —
press Q!" / "...tap the kick button!" once earned — so the mechanic and its
cost are visible to everyone playing, not just discoverable by accident.
Desktop triggers it with Q; mobile gets a dedicated `#touchSpecialBtn` that's
dim and untappable (`pointer-events: none`) until ready, then glows and
pulses. On landing, both arms swing back and both legs kick forward together
(`avatar.js`'s `leftLegPivot`/`rightLegPivot`, added alongside the existing
arm pivots), the limbs glow cyan instead of gold, the impact shockwave is
bigger, and the target's client gets a stronger camera shake
(`sceneManager.shake`) than a charged hit produces.

Verified end-to-end with a raw-socket test script driving two clients: a
shove at exact range lands and one just past the new tighter range doesn't;
three landed charged shoves (bigger force each time) produce
`specialProgress` events counting `1/3`, `2/3`, then `ready: true`; firing
`special` at that point lands with the biggest force of the three tiers and
immediately resets progress to `0/3, ready: false`; and a second attempt to
fire `special` without re-earning it is silently rejected server-side (no
`shoveHit` emitted).

## 13. Mouse/arrow control parity and themed falls

**Mouse as an alias for F/Q.** Left click now does everything F does
(hold-to-charge included) and right click does everything Q does, sharing
the exact same `onShovePress`/`onShoveRelease`/`fireSpecial` functions in
`main.js` as the keyboard — there's no separate mouse-only code path to
drift out of sync. The first click on the canvas still only engages Pointer
Lock (a browser requirement, and avoids an accidental shove firing the
instant someone clicks to start playing); once locked, the same
`mousedown`/`mouseup` pair drives the action. `contextmenu` is suppressed on
the canvas so right-click behaves as a game input, not a browser menu.
Losing pointer lock mid-hold (Escape, or any other cause) now explicitly
calls `onShoveRelease()` from the `pointerlockchange` handler, so a charge
can never get stuck mid-bar with no matching `mouseup` to close it out.

**Arrow keys.** `ArrowUp/Down/Left/Right` are plain aliases for `W/A/S/D` in
the same `keydown`/`keyup` switch — they set the exact same boolean flags,
so every existing guarantee about simultaneous input (diagonals, move+jump,
move+shove, ...) already covers them for free.

**Something under every map.** The flat void floor (a fixed dark disc at
y=-6, purely decorative) is now a themed liquid surface per map —
`maps.js#liquidColor`/`liquidGlow` (water, lava, neon goo, quicksand, ...) —
rendered with transparency and, for the glowing themes, emissive intensity
so it reads as a real surface rather than a color fill. It's now positioned
at `VOID_SURFACE_Y = -13` (`scene.js`), just above the server's
`ELIMINATION_Y = -14`, so a falling player visually plunges into it right
around the moment they're actually eliminated — previously the two values
(-6 decorative floor vs. -14 elimination) didn't line up at all. Volcano's
existing lava-pool decoration prop, which was pinned to the old -6, moved
down to sit on the new surface instead of floating in mid-air above it.

**Death effect.** The moment a player is eliminated (`scene.js#
spawnDeathEffect`, wired from `main.js`'s `onEliminated` for the local
player and a new `RemotePlayers` `onEliminated(position, color)` callback —
fired on an alive-flag `true -> false` transition — for everyone else), a
stylized "ragdoll gib" plays: a burst of small red splat blobs plus five
blocky limb/head chunks (two in the player's own torso color, three in the
avatar's skin tone) fly outward and tumble away under gravity before
fading, and a pale splash ring marks the surface itself — reusing the same
`spawnShockwave` ring effect as a charged/special hit, just retinted.
Deliberately cartoonish (primitive geometry, flat colors, ~1s fade) rather
than graphic. Fixed `spawnShockwave` to place its ring at the given
position's own Y instead of a flat `0.05` while making this change — it
had been hardcoded assuming shoves only ever happen near platform height,
which broke the moment it was reused for a splash down at the liquid
surface.

Verified: syntax-checked every touched file, confirmed via a raw-socket
client that the server's `init` payload now includes `liquidColor`/
`liquidGlow` per map, and manually re-derived the debris/splash trigger
paths for both the local-player and remote-player cases since this needed
a live two-headset session (one falling, one watching) to see rendered,
which wasn't available in this pass.

## 14. HUD architecture fix, movement polish, sprint, and grab-and-throw

**Standing architecture note.** A production-only bug report ("the charge
ring never shows, but works locally") led to a long live-debugging arc that
root-caused to `#app`'s CSS height (`100vh`/`100dvh`) resolving unreliably
small on at least one real browser, so any `position: absolute` overlay
anchored from the bottom with a real offset/size got pushed above the
visible page — invisible, with `body{overflow:hidden}` meaning no scroll
could ever reach it. **Every HUD/overlay element now uses `position: fixed`**
(anchored to the real viewport, bypassing `#app`'s box entirely), confirmed
working live in the affected browser before the fix shipped. This is now a
hard rule for any future UI: never `position: absolute` a viewport overlay.

**Movement polish.** `MOVE_SPEED` raised 5→6. Jumping/falling went through
two iterations: first "no air control" (WASD ignored entirely while
airborne, which also froze horizontal motion — jumping while running just
stopped you dead in the air), then corrected to real momentum — grounded
movement continuously records its own current velocity, and the instant
`grounded` flips false (jump, or walking off an edge) that value is locked
in as `airVelX/Z` and coasted on every frame with WASD read not at all
until landing. The mobile joystick knob also had a real bug: its CSS
applied *both* `margin-left/-top: -28px` and `transform: translate(-50%,
-50%)` — two different centering techniques stacking instead of one,
pushing the knob up-left of true center at rest. Fixed by dropping the
margin rule; touchControls.js's dynamic transform (already correct) was
the only centering that should have existed. Added a short eased
snap-back transition on release and a brighter "active" tint while
touched, and tightened the deadzone 8px→5px.

**Sprint.** Shift (desktop, either key) or pushing the mobile joystick
knob past ~80% of its max radius (checked on the *pre-clamp* magnitude in
`updateJoystick`, mimicking a real analog stick's "push further to run")
sets a `keys.sprint` boolean feeding a `MOVE_SPEED` multiplier. Made
visible three ways: the camera FOV eases wider while sprinting
(`scene.js#setSprinting`), and — since the avatar previously had **no
walk animation at all**, legs/arms were static during ordinary movement —
a proper contralateral walk/run limb cycle was added to `avatar.js`,
its frequency and stride amplitude both scaling with actual speed so
sprinting reads as visibly faster strides, not just a faster metronome.

**Grab and throw.** Server-authoritative: press E (or the mobile GRAB
button) near a valid target to grab the nearest one in range; a
successful grab forces the held player's position to sit exactly above
the holder's head every server tick (`GameRoom#updateHeldPlayers`),
overriding anything their own client reports (mirrors how a dead player's
moves are already ignored). Pressing shove while holding someone skips
the charge-hold flow entirely and immediately throws — the strongest
knockback tier in the game — in the holder's current facing direction.
Losing your grip isn't just voluntary: getting shoved while holding
someone drops them (a gentle "oops" impulse, not a hit), as does your own
elimination or disconnect, and an unthrown hold auto-releases after 5s so
it can't be used to stall a round. Two real bugs surfaced during testing
and are now guarded with comments explaining why: a held player sharing
their holder's exact (x,z) meant a third party's shove on the holder was
independently "hitting" the coincidentally-co-located captive too (fixed
by excluding `heldBy !== null` players from both `resolveCollisions` and
the shove hit-scan); and an early fix for that attempted to drop captives
*inside* the same exclusion loop, which un-excluded them retroactively
mid-iteration (fixed by collecting holders-to-drop and processing them
only after the loop completes). Avatar posing gained a documented
priority order (one-shot punch/kick/throw animation → held-tilt/limp
pose → sustained holding-overhead arm pose → walk-cycle → idle) since
several pose sources can now be simultaneously "active" (a holder who's
also walking, for instance).

**Process note.** This pass was built and checked using three parallel
agents per explicit request: one implementer, one independent verifier
that wrote its own fresh raw-socket tests rather than trusting the
implementer's self-report (and specifically re-created the double-hit bug
scenario to confirm the fix actually holds), and one pure-ideation agent
that surveyed the codebase and reported the game currently has **zero
audio anywhere** as the single highest-impact gap, ranking sound effects,
hit-stop/freeze-frame on impact, and a kill-feed ticker as the top
recommendation for a future pass. Verifier result: 22/22 independent
test cases passed, zero implementation bugs found, no `position:absolute`
regressions, no stray files. The one residual known risk, flagged
honestly by both agents: neither could render in an actual browser
(Playwright's browser download is blocked in this sandbox), so the
walk-cycle/held-tilt/holding-pose math is verified correct by trigonometry
and by confirming the underlying state is correct, but not yet confirmed
to *look* right — genuinely wants a first real playtest.

## 15. Momentum-based combat, a spectator overview, and a minimal-text pass

**Momentum.** Every attack now hits harder the faster the attacker was
actually moving the instant it landed — run into a shove, or shove/throw
while still falling from a jump, and it visibly does "bigger things," per
the request. Derived server-side (`GameRoom#updateFromClient`) from real
position deltas between consecutive move packets — not from a client-
reported velocity — so it can't be forged by claiming a fake number, only
by genuinely covering ground (or falling) that fast; the derived value is
still capped generously (`MOMENTUM_MAX_TRACKED_SPEED`/`_FALL_SPEED`) so a
lag spike or a respawn teleport can't register as a momentary "infinite
speed" burst. `GameRoom#getMomentumMultiplier` folds horizontal speed and
downward (falling) speed into one multiplier, capped overall at ~2.2x, and
applies to normal/charged/special shove force+upForce and to a throw's
force+upForce. A grab has no "force" to scale, so a fast approach instead
extends its effective range slightly (`MOMENTUM_GRAB_RANGE_*`) — reads as
a diving tackle rather than a bigger hit. Verified with a live raw-socket
test: a stationary shove lands at exactly base force, the same shove after
a fast approach lands ~2x harder (correctly hitting the tracked-speed cap,
not the overall multiplier cap), the same scaling carries through to a
charged shove, and a grab at a distance that would fail at rest succeeds
once the attacker is moving fast enough to extend the range into it.

**Spectator overview.** Elimination used to just leave the camera stuck on
your own settled corpse for the rest of the round. Now, `main.js` waits
`SPECTATE_DELAY_MS` (1.8s — long enough to actually see your own death
effect) before easing the camera up into a high, slightly-angled overview
of the whole arena (`scene.js#updateSpectatorCamera`), so you can watch
who's still alive until the round restarts. Deliberately not a pure
straight-down 90° angle — that flattens every player into an
indistinguishable dot; the slight backward offset keeps height/shape
readable. Existing name-sprites already billboard toward the camera
regardless of angle, so player names stay legible from directly above with
no extra work. Resets cleanly on respawn (`onRoundStart`) and disconnect.

**Minimal in-game text.** The full control list moved to a single place —
a new `#howToPlay` card on the login screen, populated by `main.js`
per-device (a desktop list mentioning Shift/mouse, or a touch list
mentioning the joystick/on-screen buttons — a touch player was never going
to see a "Shift" key). Every in-game hint now assumes that was already
seen once and just needs to jog memory: `#controlsHint` shrank from seven
explanatory lines to three bare key/action pairs, the special-power hint
went from "Land 2 more charged shoves" to a plain `2 / 3` (the pips
already carry the visual progress — the text only needs to add what to
press), and banner copy was trimmed throughout ("You've been grabbed! Hope
for a rescue or brace for a throw..." → "Grabbed! / Brace yourself...").

## 16. Mobile compacting, sound effects, hit-stop, and landing squash

**Mobile UI compacting.** Mobile's own browser chrome (URL bar) already
claims real vertical space at the top of the viewport on top of whatever
`100dvh` doesn't reclaim, and the top-anchored HUD/special-meter were
still using desktop spacing there. `main.js` now adds a `touch-ui` class
to `<body>` on touch devices, and `body.touch-ui` CSS overrides shrink
`#hud` (tighter padding, `Map: X · Alive: Y/Z` on one line instead of two)
and `#specialMeter` (drops the "SPECIAL POWER" title line entirely — the
pips plus a short hint are already self-explanatory — and shrinks the
pips/padding/font).

**Sound effects.** The game had zero audio anywhere before this — flagged
by an earlier ideation pass as the single biggest gap for "feel real."
`client/src/audio.js` synthesizes everything via the Web Audio API
(oscillator tones layered with tapered noise bursts for impacts) — no
sound files, nothing to load or license. `initAudio()` runs from the PLAY
button's click handler specifically, since starting an `AudioContext`
requires a real user gesture and that's the first one in the app's
lifecycle. Shoves/kicks/throws pitch down and grow louder/longer by power
tier so a bigger hit sounds bigger with no per-tier assets; eliminations,
grabs, a special-ready chime (fired only on the false→true readiness
edge, not every progress tick), and round wins each get their own short
cue.

**Hit-stop.** A brief near-freeze (`HIT_STOP_MS`, scaled by power tier) on
any landed hit — felt by both the attacker and the target, not just the
one getting knocked back, matching how fighting games pause the whole
screen on impact rather than just the two combatants. Implemented as a
local, purely cosmetic scale-down of `dt` for a few real milliseconds in
`main.js`'s render loop (`dt *= 0.06`, not literally 0 — keeps easing/decay
math well-behaved) — nothing about what's sent to or trusted from the
server changes.

**Landing squash-and-stretch.** `player.js` now captures `wasGrounded`
each frame and, on the exact falling→grounded edge, reads the pre-reset
`velocityY` (how fast the fall actually was) to scale a squash intensity
from 0 (a short hop, barely registers) to 1 (a real fall). `avatar.js`'s
`triggerLandSquash` sets that as the avatar group's target squash, which
decays back to neutral over the next several frames — scaling
`avatar.group.scale` around the group's own origin, which sits at the
character's feet, so the squash correctly compresses the body toward the
ground plane instead of sinking the whole avatar into it. Local-player
only for this pass (same scope as camera shake/hit-stop) — extending it
to remote players would need inferring fall speed from their
interpolated position rather than a real physics value, which is more
fragile than worth it for a cosmetic effect. Verified server-side changes
(momentum's continued correctness) with a live raw-socket run; the audio/
hit-stop/squash pieces are client-only and were checked by full re-reads
of the changed logic plus confirming they occupy independent transform/
state channels from every existing pose system (rotation.x/y/z, arm/leg
pivots, materials) rather than by a real browser render, same known
limitation as the walk-cycle/held-tilt work a couple passes back.
