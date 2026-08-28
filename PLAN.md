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

Ships with **8 maps**, each a distinct subject:

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
