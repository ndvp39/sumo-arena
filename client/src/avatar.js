import * as THREE from 'three';
import { PUNCH_ANIM_MS, CHARGED_PUNCH_ANIM_MS, SPECIAL_KICK_ANIM_MS } from './constants.js';

// Animation profile per shove power tier. 'special' swings both arms back
// and both legs forward together (a two-legged flying kick), and both
// tiers above 'normal' pulse an emissive glow on the swinging limbs so the
// windup/impact reads clearly from a distance, not just up close.
const POWER_ANIM = {
  normal:  { duration: PUNCH_ANIM_MS,        armSwing: Math.PI / 2.1, legSwing: 0,            glow: null },
  charged: { duration: CHARGED_PUNCH_ANIM_MS, armSwing: Math.PI / 1.7, legSwing: 0,            glow: 0xffcc33 },
  special: { duration: SPECIAL_KICK_ANIM_MS,  armSwing: Math.PI / 2.5, legSwing: Math.PI / 2.4, glow: 0x66e0ff }
};

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
    fallProgress: 0
  };
}

// Called once per frame per avatar. Animates the punch/kick swing (shape
// and glow depend on the shove's power tier, see POWER_ANIM above) and,
// once eliminated, a topple-and-fade so the player visibly drops out.
export function updateAvatar(avatar, now, isAlive) {
  const { leftArmPivot, rightArmPivot, leftLegPivot, rightLegPivot, armMaterial, legMaterial } = avatar.parts;
  const cfg = POWER_ANIM[avatar.punchPower] || POWER_ANIM.normal;
  const elapsed = now - avatar.punchStartTime;

  if (elapsed >= 0 && elapsed < cfg.duration) {
    const t = elapsed / cfg.duration;
    const s = Math.sin(t * Math.PI);

    const armSwing = s * cfg.armSwing;
    leftArmPivot.rotation.x = -armSwing;
    rightArmPivot.rotation.x = -armSwing;

    const legSwing = s * cfg.legSwing;
    leftLegPivot.rotation.x = -legSwing;
    rightLegPivot.rotation.x = -legSwing;

    const glowIntensity = cfg.glow ? s * 0.9 : 0;
    armMaterial.emissive.setHex(cfg.glow || 0x000000);
    armMaterial.emissiveIntensity = glowIntensity;
    legMaterial.emissive.setHex(cfg.glow || 0x000000);
    legMaterial.emissiveIntensity = cfg.legSwing ? glowIntensity : 0;
  } else {
    leftArmPivot.rotation.x = 0;
    rightArmPivot.rotation.x = 0;
    leftLegPivot.rotation.x = 0;
    rightLegPivot.rotation.x = 0;
    armMaterial.emissiveIntensity = 0;
    legMaterial.emissiveIntensity = 0;
  }

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

// Restores an avatar to fully visible after a respawn. Must be called
// explicitly by respawn code rather than left to updateAvatar's own
// "isAlive && fallProgress > 0" reset branch above: respawn code sets
// fallProgress directly to 0, which is exactly the value that makes that
// branch's condition false, so materials faded out by a prior death/fall
// would otherwise never get their opacity restored.
export function resetAvatarVisuals(avatar) {
  avatar.fallProgress = 0;
  avatar.group.rotation.z = 0;
  avatar.group.traverse((obj) => {
    if (obj.material) obj.material.opacity = 1;
  });
}
