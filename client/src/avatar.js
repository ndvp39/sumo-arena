import * as THREE from 'three';
import { PUNCH_ANIM_MS, CHARGED_PUNCH_ANIM_MS, SPECIAL_KICK_ANIM_MS, WALK_CYCLE_HZ_PER_SPEED } from './constants.js';

// Animation profile per shove power tier. 'special' swings both arms back
// and both legs forward together (a two-legged flying kick), and every
// tier above 'normal' pulses an emissive glow on the swinging limbs so the
// windup/impact reads clearly from a distance, not just up close. 'throw'
// (grab-and-throw, see GameRoom#throwHeldPlayer) swings the arms furthest
// of all — a big two-handed heave — with its own hot color so it reads as
// distinct from charged's gold and special's cyan.
const POWER_ANIM = {
  normal:  { duration: PUNCH_ANIM_MS,        armSwing: Math.PI / 2.1, legSwing: 0,            glow: null },
  charged: { duration: CHARGED_PUNCH_ANIM_MS, armSwing: Math.PI / 1.7, legSwing: 0,            glow: 0xffcc33 },
  special: { duration: SPECIAL_KICK_ANIM_MS,  armSwing: Math.PI / 2.5, legSwing: Math.PI / 2.4, glow: 0x66e0ff },
  throw:   { duration: SPECIAL_KICK_ANIM_MS,  armSwing: Math.PI / 1.5, legSwing: 0,            glow: 0xff5522 }
};

// Walk/run locomotion cycle — see updateAvatar's walk-cycle branch. Legs
// swing more than arms (a natural gait), and both get a modest extra boost
// at higher speed on top of the cycle simply running faster, so sprinting
// reads as bigger strides too and not just a faster metronome.
const LEG_WALK_AMPLITUDE = Math.PI / 6;
const ARM_WALK_AMPLITUDE = Math.PI / 9;
const WALK_MOVING_THRESHOLD = 0.15; // units/sec — below this, treat as standing still

// Sustained pose while holding someone overhead (GameRoom's `holding`) —
// not a timed animation like POWER_ANIM, just a fixed angle held for as
// long as isHolding stays true.
const HOLDING_ARM_ANGLE = -Math.PI * 0.92;

function makeNameSprite(name) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 64;

  ctx.font = 'bold 32px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 8, canvas.width, 40);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name.slice(0, 16), canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.set(0, 2.05, 0);
  sprite.renderOrder = 999;
  return sprite;
}

// Builds a simple human-like avatar from primitive geometries:
// head (sphere), torso (box), arms & legs (boxes). Arms are parented to
// shoulder pivot groups so they can swing forward for the shove animation.
export function createAvatar(name, colorHex) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xf0c8a0, roughness: 0.7 });
  // Arms/legs get their own material instances (cloned from skin) so a
  // charged/special glow can pulse just the swinging limbs without
  // affecting the head.
  const armMaterial = skinMaterial.clone();
  const legMaterial = skinMaterial.clone();

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.35), material);
  torso.position.y = 1.0;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), skinMaterial);
  head.position.y = 1.68;
  head.castShadow = true;
  group.add(head);

  // Legs are parented to hip pivot groups (mirroring the arm pivots below)
  // so both can swing forward together for the special two-legged kick.
  const legGeom = new THREE.BoxGeometry(0.22, 0.75, 0.22);

  function makeLegPivot(sideSign) {
    const pivot = new THREE.Group();
    pivot.position.set(sideSign * 0.16, 0.6, 0);
    const leg = new THREE.Mesh(legGeom, legMaterial);
    leg.position.set(0, -0.375, 0);
    leg.castShadow = true;
    pivot.add(leg);
    return pivot;
  }

  const leftLegPivot = makeLegPivot(-1);
  const rightLegPivot = makeLegPivot(1);
  group.add(leftLegPivot, rightLegPivot);

  const armGeom = new THREE.BoxGeometry(0.18, 0.6, 0.18);

  function makeArmPivot(sideSign) {
    const pivot = new THREE.Group();
    pivot.position.set(sideSign * 0.42, 1.35, 0);
    const arm = new THREE.Mesh(armGeom, armMaterial);
    arm.position.set(0, -0.3, 0);
    arm.castShadow = true;
    pivot.add(arm);
    return pivot;
  }

  const leftArmPivot = makeArmPivot(-1);
  const rightArmPivot = makeArmPivot(1);
  group.add(leftArmPivot, rightArmPivot);

  const nameSprite = makeNameSprite(name);
  group.add(nameSprite);

  return {
    group,
    parts: { torso, head, leftArmPivot, rightArmPivot, leftLegPivot, rightLegPivot, nameSprite, armMaterial, legMaterial },
    punchStartTime: -Infinity,
    punchPower: 'normal',
    fallProgress: 0,
    walkPhase: 0,          // radians; advances with moveSpeed*dt, see updateAvatar's walk-cycle
    heldTiltProgress: 0,   // 0..1, eased toward isHeld — see updateAvatar
    landSquashProgress: 0  // 0..1, decays to 0 — see triggerLandSquash/updateAvatar
  };
}

// Called once per frame per avatar. `state` bundles everything that
// decides which pose the limbs take this frame — several pose sources can
// be "active" at once (e.g. a holder who's also mid-walk-cycle), so the
// priority order matters and is worth spelling out:
//   1. A one-shot punch/kick/throw animation (POWER_ANIM) always wins for
//      the arms, and for the legs only when its own legSwing is nonzero
//      (only the special kick moves legs) — a shove/throw reads as an
//      interruption of whatever else the limbs were doing.
//   2. isHeld (being carried) freezes arms/legs in a relaxed pose and
//      tilts the whole body toward horizontal — a held player can't be
//      walking (the server ignores their input entirely), so this always
//      beats walk-cycle for both arms and legs.
//   3. isHolding gives the ARMS a sustained overhead pose for as long as
//      it's true. The LEGS are NOT claimed by this — they still walk-cycle
//      normally below, since the holder can keep walking while carrying
//      someone.
//   4. Walk-cycle drives whichever of arms/legs isn't already claimed by
//      1-3 above, whenever moveSpeed is above WALK_MOVING_THRESHOLD.
//   5. Otherwise, idle (rotation reset to neutral).
// Also handles the once-eliminated topple-and-fade so the player visibly
// drops out.
export function updateAvatar(avatar, now, dt, state = {}) {
  const { isAlive = true, isHeld = false, isHolding = false, moveSpeed = 0 } = state;
  const { leftArmPivot, rightArmPivot, leftLegPivot, rightLegPivot, armMaterial, legMaterial } = avatar.parts;
  const cfg = POWER_ANIM[avatar.punchPower] || POWER_ANIM.normal;
  const elapsed = now - avatar.punchStartTime;
  const punchActive = elapsed >= 0 && elapsed < cfg.duration;

  // Advances unconditionally (cheap, and keeps the cycle continuous so
  // resuming movement after a punch/hold doesn't pop to a random phase),
  // even on frames where something else ends up claiming the limbs.
  avatar.walkPhase += moveSpeed * dt * WALK_CYCLE_HZ_PER_SPEED * Math.PI * 2;

  let glowIntensity = 0;
  let glowColor = 0x000000;
  let legGlow = false;

  if (punchActive) {
    const t = elapsed / cfg.duration;
    const s = Math.sin(t * Math.PI);
    const armAngle = -s * cfg.armSwing;
    const legAngle = -s * cfg.legSwing;
    leftArmPivot.rotation.x = armAngle;
    rightArmPivot.rotation.x = armAngle;
    leftLegPivot.rotation.x = legAngle;
    rightLegPivot.rotation.x = legAngle;
    glowIntensity = cfg.glow ? s * 0.9 : 0;
    glowColor = cfg.glow || 0x000000;
    legGlow = cfg.legSwing > 0;
  } else if (isHeld) {
    // Limp/relaxed — arms drooping slightly forward, legs trailing back —
    // reads as "being carried" rather than standing at attention mid-air.
    leftArmPivot.rotation.x = -0.3;
    rightArmPivot.rotation.x = -0.3;
    leftLegPivot.rotation.x = 0.15;
    rightLegPivot.rotation.x = 0.15;
  } else {
    const moving = moveSpeed > WALK_MOVING_THRESHOLD;
    const speedScale = moving ? 1 + Math.min(0.5, moveSpeed / 16) : 1;

    if (isHolding) {
      leftArmPivot.rotation.x = HOLDING_ARM_ANGLE;
      rightArmPivot.rotation.x = HOLDING_ARM_ANGLE;
    } else if (moving) {
      // Contralateral gait: each arm shares phase with the OPPOSITE leg
      // (left arm forward with right leg forward, like actually walking).
      leftArmPivot.rotation.x = Math.sin(avatar.walkPhase + Math.PI) * ARM_WALK_AMPLITUDE * speedScale;
      rightArmPivot.rotation.x = Math.sin(avatar.walkPhase) * ARM_WALK_AMPLITUDE * speedScale;
    } else {
      leftArmPivot.rotation.x = 0;
      rightArmPivot.rotation.x = 0;
    }

    if (moving) {
      leftLegPivot.rotation.x = Math.sin(avatar.walkPhase) * LEG_WALK_AMPLITUDE * speedScale;
      rightLegPivot.rotation.x = Math.sin(avatar.walkPhase + Math.PI) * LEG_WALK_AMPLITUDE * speedScale;
    } else {
      leftLegPivot.rotation.x = 0;
      rightLegPivot.rotation.x = 0;
    }
  }

  armMaterial.emissive.setHex(glowColor);
  armMaterial.emissiveIntensity = glowIntensity;
  legMaterial.emissive.setHex(glowColor);
  legMaterial.emissiveIntensity = legGlow ? glowIntensity : 0;

  // Eases toward horizontal while held, back to upright otherwise — a
  // fixed-step ease (matching fallProgress's own style just below) since
  // this only ever needs to complete over a handful of frames either way.
  avatar.heldTiltProgress = isHeld
    ? Math.min(1, avatar.heldTiltProgress + 0.15)
    : Math.max(0, avatar.heldTiltProgress - 0.15);
  avatar.group.rotation.x = -avatar.heldTiltProgress * (Math.PI / 2 - 0.25);

  // Squash-and-stretch on landing (triggerLandSquash, called from
  // player.js the instant a fall/jump ends) — a fixed per-frame decay
  // rather than dt-scaled, matching heldTiltProgress/fallProgress's own
  // style just above/below, since this only ever needs to resolve over a
  // handful of frames regardless of framerate.
  avatar.landSquashProgress = Math.max(0, avatar.landSquashProgress - 0.08);
  const squash = avatar.landSquashProgress;
  avatar.group.scale.set(1 + squash * 0.18, 1 - squash * 0.28, 1 + squash * 0.18);

  if (!isAlive && avatar.fallProgress < 1) {
    avatar.fallProgress = Math.min(1, avatar.fallProgress + 0.035);
    avatar.group.rotation.z = avatar.fallProgress * (Math.PI / 2);
    avatar.group.position.y -= 0.02;
    avatar.group.traverse((obj) => {
      if (obj.material && obj.material.transparent !== undefined) {
        obj.material.transparent = true;
        obj.material.opacity = 1 - avatar.fallProgress;
      }
    });
  } else if (isAlive && avatar.fallProgress > 0) {
    avatar.fallProgress = 0;
    avatar.group.rotation.z = 0;
    avatar.group.traverse((obj) => {
      if (obj.material) obj.material.opacity = 1;
    });
  }
}

export function triggerPunch(avatar, now, power = 'normal') {
  avatar.punchStartTime = now;
  avatar.punchPower = power;
}

// intensity: 0..1, scaled by how hard the landing was (see player.js) —
// bigger falls squash more. Called once at the exact moment of landing,
// not every frame; updateAvatar's own decay handles springing back out of it.
export function triggerLandSquash(avatar, intensity) {
  avatar.landSquashProgress = Math.max(avatar.landSquashProgress, Math.min(1, intensity));
}

// Restores an avatar to fully visible after a respawn. Must be called
// explicitly by respawn code rather than left to updateAvatar's own
// "isAlive && fallProgress > 0" reset branch above: respawn code sets
// fallProgress directly to 0, which is exactly the value that makes that
// branch's condition false, so materials faded out by a prior death/fall
// would otherwise never get their opacity restored.
export function resetAvatarVisuals(avatar) {
  avatar.fallProgress = 0;
  avatar.heldTiltProgress = 0;
  avatar.landSquashProgress = 0;
  avatar.group.rotation.z = 0;
  avatar.group.rotation.x = 0;
  avatar.group.scale.set(1, 1, 1);
  avatar.group.traverse((obj) => {
    if (obj.material) obj.material.opacity = 1;
  });
}
