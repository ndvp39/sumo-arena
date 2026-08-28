// Map registry. To add a new arena, add an entry here — nothing else needs to
// change. The client has no hardcoded knowledge of any map; it builds arena
// geometry, sky, lighting tint and themed decorations dynamically from
// whatever config it receives (see 'init'/'roundStart' events and
// client/src/scene.js#buildArena / #buildDecorations).
//
// Fields:
//   id            unique key
//   name          display name shown in the HUD
//   radius        ring radius (boundary used for elimination checks)
//   spawnRadius   ring on which players are spawned, evenly spaced
//   height        platform thickness (purely visual)
//   groundColor   hex color of the platform surface
//   ringColor     hex color of the boundary trim ring
//   voidColor     hex color of the abyss below/around the platform
//   skyColor      top-of-sky gradient color (paired with voidColor as horizon)
//   lightColor    tint of the main directional "sun" light
//   lightIntensity  strength of that light
//   ambientColor  tint of the ambient fill light
//   emissiveGround  hex color the platform glows, or null for a matte floor
//   decoration    theme key consumed by scene.js#buildDecorations

export const MAPS = {
  classic: {
    id: 'classic',
    name: 'Classic Dohyo',
    radius: 8,
    spawnRadius: 8 * 0.55,
    height: 0.5,
    groundColor: 0xd8a56b,
    ringColor: 0xffffff,
    voidColor: 0x05050a,
    skyColor: 0x2a2440,
    lightColor: 0xfff4e0,
    lightIntensity: 1.1,
    ambientColor: 0xffffff,
    emissiveGround: null,
    decoration: 'dohyo'
  },
  smallRing: {
    id: 'smallRing',
    name: 'Small Ring',
    radius: 5,
    spawnRadius: 5 * 0.5,
    height: 0.5,
    groundColor: 0xc0392b,
    ringColor: 0xf1c40f,
    voidColor: 0x140a0a,
    skyColor: 0x3a1414,
    lightColor: 0xffe0c0,
    lightIntensity: 1.15,
    ambientColor: 0xffddcc,
    emissiveGround: null,
    decoration: 'dohyo'
  },
  grandArena: {
    id: 'grandArena',
    name: 'Grand Arena',
    radius: 12,
    spawnRadius: 12 * 0.6,
    height: 0.6,
    groundColor: 0x2c3e50,
    ringColor: 0x00e5ff,
    voidColor: 0x00000a,
    skyColor: 0x0a1a2a,
    lightColor: 0xbfe8ff,
    lightIntensity: 1.0,
    ambientColor: 0x88aaff,
    emissiveGround: null,
    decoration: 'pillars'
  },
  volcano: {
    id: 'volcano',
    name: 'Volcano Pit',
    radius: 7,
    spawnRadius: 7 * 0.5,
    height: 0.5,
    groundColor: 0x2b1410,
    ringColor: 0xff5522,
    voidColor: 0x1a0502,
    skyColor: 0x4a1204,
    lightColor: 0xff8844,
    lightIntensity: 1.3,
    ambientColor: 0xff6633,
    emissiveGround: 0x552200,
    decoration: 'lava'
  },
  frozen: {
    id: 'frozen',
    name: 'Frozen Wastes',
    radius: 8,
    spawnRadius: 8 * 0.55,
    height: 0.5,
    groundColor: 0xdbeeff,
    ringColor: 0x66ddff,
    voidColor: 0x0a1622,
    skyColor: 0xaee0ff,
    lightColor: 0xdff5ff,
    lightIntensity: 1.2,
    ambientColor: 0xbfe6ff,
    emissiveGround: null,
    decoration: 'ice'
  },
  neonGrid: {
    id: 'neonGrid',
    name: 'Neon Grid',
    radius: 8,
    spawnRadius: 8 * 0.55,
    height: 0.4,
    groundColor: 0x0a0a14,
    ringColor: 0xff00ff,
    voidColor: 0x000000,
    skyColor: 0x120022,
    lightColor: 0x00ffff,
    lightIntensity: 0.9,
    ambientColor: 0xff00ff,
    emissiveGround: 0x1a0033,
    decoration: 'neon'
  },
  desertMesa: {
    id: 'desertMesa',
    name: 'Desert Mesa',
    radius: 9,
    spawnRadius: 9 * 0.55,
    height: 0.5,
    groundColor: 0xe0b070,
    ringColor: 0xa0522d,
    voidColor: 0x3a2410,
    skyColor: 0xffb060,
    lightColor: 0xffddaa,
    lightIntensity: 1.35,
    ambientColor: 0xffcc99,
    emissiveGround: null,
    decoration: 'desert'
  },
  deepSpace: {
    id: 'deepSpace',
    name: 'Deep Space Station',
    radius: 7.5,
    spawnRadius: 7.5 * 0.5,
    height: 0.4,
    groundColor: 0x3a3f4a,
    ringColor: 0xffffff,
    voidColor: 0x000000,
    skyColor: 0x000005,
    lightColor: 0xccddff,
    lightIntensity: 1.0,
    ambientColor: 0x334466,
    emissiveGround: null,
    decoration: 'space'
  }
};

export const MAP_ROTATION = [
  'classic', 'volcano', 'smallRing', 'frozen',
  'grandArena', 'neonGrid', 'desertMesa', 'deepSpace'
];
export const DEFAULT_MAP_ID = 'classic';

export function getMap(id) {
  return MAPS[id] || MAPS[DEFAULT_MAP_ID];
}

export function listMaps() {
  return Object.values(MAPS).map(({ id, name, radius }) => ({ id, name, radius }));
}

export function nextMapId(currentId) {
  const idx = MAP_ROTATION.indexOf(currentId);
  return MAP_ROTATION[(idx + 1) % MAP_ROTATION.length];
}
