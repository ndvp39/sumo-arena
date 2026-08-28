import * as THREE from 'three';

// Owns the renderer, camera, lighting, and the arena mesh. The arena is
// rebuilt on demand from a map config object sent by the server — there is
// no hardcoded arena here, so any map the server knows about (radius, ring
// colors, sky, light tint, decoration theme, ...) renders correctly without
// client changes; see server/maps.js for the schema.
export class SceneManager {
  constructor(canvas) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a14);
    this.scene.fog = new THREE.Fog(0x0a0a14, 20, 55);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;

    this._setupLighting();

    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);
    this.currentMapId = null;

    this._desiredCamPos = new THREE.Vector3(); // reused each frame — avoid per-frame GC churn

    window.addEventListener('resize', () => this.onResize());
  }

  _setupLighting() {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.sunLight.position.set(8, 14, 6);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.camera.far = 40;
    this.scene.add(this.sunLight);

    this.fillLight = new THREE.PointLight(0x88aaff, 0.4, 40);
    this.fillLight.position.set(-10, 8, -10);
    this.scene.add(this.fillLight);
  }

  // Vertical gradient sky (sky color at the top fading to the void color at
  // the horizon) rendered to a small canvas — cheap, no external assets,
  // and gives every map a distinct backdrop instead of a flat fill.
  _buildSkyTexture(topHex, bottomHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, `#${topHex.toString(16).padStart(6, '0')}`);
    grad.addColorStop(1, `#${bottomHex.toString(16).padStart(6, '0')}`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  // Tears down the previous arena (if any) and builds a new one from the
  // given map config sent by the server.
  buildArena(map) {
    if (this.currentMapId === map.id) return;
    this.currentMapId = map.id;

    while (this.arenaGroup.children.length) {
      const child = this.arenaGroup.children.pop();
      child.geometry?.dispose();
      child.material?.dispose();
    }

    const height = map.height ?? 0.5;

    const groundMat = new THREE.MeshStandardMaterial({
      color: map.groundColor,
      roughness: 0.85,
      emissive: map.emissiveGround ?? 0x000000,
      emissiveIntensity: map.emissiveGround ? 0.55 : 0
    });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(map.radius, map.radius, height, 64), groundMat);
    platform.position.y = -height / 2;
    platform.receiveShadow = true;
    this.arenaGroup.add(platform);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(map.radius, 0.08, 12, 80),
      new THREE.MeshStandardMaterial({ color: map.ringColor, roughness: 0.4, emissive: map.ringColor, emissiveIntensity: 0.3 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    this.arenaGroup.add(ring);

    const voidFloor = new THREE.Mesh(
      new THREE.CircleGeometry(map.radius * 4, 48),
      new THREE.MeshStandardMaterial({ color: map.voidColor, roughness: 1 })
    );
    voidFloor.rotation.x = -Math.PI / 2;
    voidFloor.position.y = -6;
    this.arenaGroup.add(voidFloor);

    this.scene.fog.color.set(map.voidColor);
    const skyTop = map.skyColor ?? map.voidColor;
    const oldBg = this.scene.background;
    this.scene.background = this._buildSkyTexture(skyTop, map.voidColor);
    if (oldBg?.dispose) oldBg.dispose();

    this.ambientLight.color.set(map.ambientColor ?? 0xffffff);
    this.sunLight.color.set(map.lightColor ?? 0xffffff);
    this.sunLight.intensity = map.lightIntensity ?? 1.1;
    this.fillLight.color.set(map.ringColor ?? 0x88aaff);

    this._buildDecorations(map);
  }

  // Themed procedural props built from primitive geometries only (no
  // external assets), placed in a ring just outside the boundary. Adding a
  // new theme here + a `decoration` key on a map is all it takes.
  _buildDecorations(map) {
    const builders = {
      dohyo: () => this._decorateDohyo(map),
      pillars: () => this._decoratePillars(map),
      lava: () => this._decorateLava(map),
      ice: () => this._decorateIce(map),
      neon: () => this._decorateNeon(map),
      desert: () => this._decorateDesert(map),
      space: () => this._decorateSpace(map)
    };
    (builders[map.decoration] || (() => {}))();
  }

  _ringOfProps(count, radiusMul, map, builderFn) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + 0.3;
      const x = Math.cos(angle) * map.radius * radiusMul;
      const z = Math.sin(angle) * map.radius * radiusMul;
      const prop = builderFn(i, angle);
      prop.position.x += x;
      prop.position.z += z;
      this.arenaGroup.add(prop);
    }
  }

  _decorateDohyo(map) {
    this._ringOfProps(4, 1.28, map, () => {
      const g = new THREE.Group();
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.18, 3.2, 10),
        new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 })
      );
      post.position.y = 1.6;
      g.add(post);
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.35, 0.05),
        new THREE.MeshStandardMaterial({ color: map.ringColor, emissive: map.ringColor, emissiveIntensity: 0.3 })
      );
      flag.position.set(0.28, 3.0, 0);
      g.add(flag);
      return g;
    });
  }

  _decoratePillars(map) {
    this._ringOfProps(6, 1.15, map, () => {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 4.5, 12),
        new THREE.MeshStandardMaterial({ color: 0x1a2430, emissive: map.ringColor, emissiveIntensity: 0.6, roughness: 0.5 })
      );
      pillar.position.y = 2.25;
      return pillar;
    });
  }

  _decorateLava(map) {
    this._ringOfProps(10, 1.1 + Math.random() * 0.3, map, () => {
      const h = 1.2 + Math.random() * 1.6;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.35 + Math.random() * 0.25, h, 6),
        new THREE.MeshStandardMaterial({ color: 0x1c0e08, roughness: 1, emissive: 0x552200, emissiveIntensity: 0.25 })
      );
      spike.position.y = h / 2 - 0.3;
      spike.rotation.y = Math.random() * Math.PI;
      return spike;
    });
    this._ringOfProps(6, 1.7 + Math.random() * 0.4, map, () => {
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(0.9 + Math.random() * 0.6, 20),
        new THREE.MeshStandardMaterial({ color: 0xff4400, emissive: 0xff5500, emissiveIntensity: 1.1, roughness: 0.6 })
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = -5.98;
      return pool;
    });
  }

  _decorateIce(map) {
    this._ringOfProps(9, 1.1 + Math.random() * 0.35, map, () => {
      const h = 1.5 + Math.random() * 2;
      const crystal = new THREE.Mesh(
        new THREE.ConeGeometry(0.3 + Math.random() * 0.2, h, 5),
        new THREE.MeshStandardMaterial({
          color: 0xcdf3ff, roughness: 0.15, metalness: 0.1,
          transparent: true, opacity: 0.75, emissive: 0x2288aa, emissiveIntensity: 0.15
        })
      );
      crystal.position.y = h / 2 - 0.2;
      crystal.rotation.y = Math.random() * Math.PI;
      return crystal;
    });
  }

  _decorateNeon(map) {
    // Faint neon grid overlay on the platform top, cyberpunk-style.
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = 256;
    gridCanvas.height = 256;
    const ctx = gridCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(0,255,255,0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    const gridTex = new THREE.CanvasTexture(gridCanvas);
    const gridDisc = new THREE.Mesh(
      new THREE.CircleGeometry(map.radius * 0.98, 48),
      new THREE.MeshBasicMaterial({ map: gridTex, transparent: true, opacity: 0.5 })
    );
    gridDisc.rotation.x = -Math.PI / 2;
    gridDisc.position.y = (map.height ?? 0.4) / 2 + 0.01;
    this.arenaGroup.add(gridDisc);

    this._ringOfProps(8, 1.2, map, (i) => {
      const tint = i % 2 === 0 ? map.ringColor : map.lightColor;
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 3.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x0a0a10, emissive: tint, emissiveIntensity: 0.9 })
      );
      pylon.position.y = 1.8;
      return pylon;
    });
  }

  _decorateDesert(map) {
    this._ringOfProps(8, 1.15 + Math.random() * 0.3, map, (i) => {
      if (i % 3 === 0) {
        // cactus
        const g = new THREE.Group();
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3f7d3f, roughness: 0.8 });
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 1.8, 8), trunkMat);
        trunk.position.y = 0.9;
        g.add(trunk);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 6), trunkMat);
        arm.position.set(0.3, 1.1, 0);
        arm.rotation.z = Math.PI / 2.5;
        g.add(arm);
        return g;
      }
      const h = 0.8 + Math.random() * 1.2;
      const rock = new THREE.Mesh(
        new THREE.ConeGeometry(0.5 + Math.random() * 0.3, h, 5),
        new THREE.MeshStandardMaterial({ color: 0xb08050, roughness: 1 })
      );
      rock.position.y = h / 2 - 0.2;
      rock.rotation.y = Math.random() * Math.PI;
      return rock;
    });
  }

  _decorateSpace(map) {
    const starCount = 500;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 30 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.6 + 2;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(starGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, sizeAttenuation: true }));
    this.arenaGroup.add(stars);

    this._ringOfProps(5, 1.6 + Math.random() * 0.6, map, () => {
      const s = 0.4 + Math.random() * 0.5;
      const asteroid = new THREE.Mesh(
        new THREE.IcosahedronGeometry(s, 0),
        new THREE.MeshStandardMaterial({ color: 0x555a66, roughness: 1, flatShading: true })
      );
      asteroid.position.y = 1 + Math.random() * 2;
      asteroid.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      return asteroid;
    });
  }

  // Mouse-look third-person orbit camera: yaw/pitch come from accumulated
  // mouse movement (see main.js pointer-lock handling), not from the
  // avatar's own rotation, so looking around never fights with movement.
  updateCamera(targetPos, yaw, pitch, dt) {
    const distance = 6.5;
    const baseHeight = 1.6;

    const horizDist = distance * Math.cos(pitch);
    const vertOffset = baseHeight + distance * Math.sin(pitch);

    this._desiredCamPos.set(
      targetPos.x - Math.sin(yaw) * horizDist,
      targetPos.y + vertOffset,
      targetPos.z - Math.cos(yaw) * horizDist
    );
    const alpha = 1 - Math.pow(0.0001, dt);
    this.camera.position.lerp(this._desiredCamPos, alpha);
    this.camera.lookAt(targetPos.x, targetPos.y + 1.2, targetPos.z);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
