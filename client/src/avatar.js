import * as THREE from 'three';
import { PUNCH_ANIM_MS } from './constants.js';

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

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.35), material);
  torso.position.y = 1.0;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), skinMaterial);
  head.position.y = 1.68;
  head.castShadow = true;
  group.add(head);

  const legGeom = new THREE.BoxGeometry(0.22, 0.75, 0.22);
  const leftLeg = new THREE.Mesh(legGeom, skinMaterial);
  leftLeg.position.set(-0.16, 0.22, 0);
  leftLeg.castShadow = true;
  const rightLeg = leftLeg.clone();
  rightLeg.position.set(0.16, 0.22, 0);
  group.add(leftLeg, rightLeg);

  const armGeom = new THREE.BoxGeometry(0.18, 0.6, 0.18);

  function makeArmPivot(sideSign) {
    const pivot = new THREE.Group();
    pivot.position.set(sideSign * 0.42, 1.35, 0);
    const arm = new THREE.Mesh(armGeom, skinMaterial);
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
    parts: { torso, head, leftArmPivot, rightArmPivot, nameSprite },
    punchStartTime: -Infinity,
    fallProgress: 0
  };
}

// Called once per frame per avatar. Animates the punch swing and, once
// eliminated, a topple-and-fade so the player visibly drops out.
export function updateAvatar(avatar, now, isAlive) {
  const { leftArmPivot, rightArmPivot } = avatar.parts;
  const elapsed = now - avatar.punchStartTime;
  if (elapsed >= 0 && elapsed < PUNCH_ANIM_MS) {
    const t = elapsed / PUNCH_ANIM_MS;
    const swing = Math.sin(t * Math.PI) * (Math.PI / 2.1);
    leftArmPivot.rotation.x = -swing;
    rightArmPivot.rotation.x = -swing;
  } else {
    leftArmPivot.rotation.x = 0;
    rightArmPivot.rotation.x = 0;
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

export function triggerPunch(avatar, now) {
  avatar.punchStartTime = now;
}
