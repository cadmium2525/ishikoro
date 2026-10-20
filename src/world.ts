import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { GRASS_LOT, GUTTERS, HOME_GATE_X, HOME_MAT, HOME_ROAD, MAIN_ROAD, PAVED, POLES, ROAD_A, WALLS, type Rect } from './level';

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/**
 * 同じ材質の静的メッシュを1つにまとめるための入れ物。
 * 家や塀は数が多いので、描画呼び出しを材質ごとに1回へ減らす。
 */
class Batcher {
  private readonly parts = new Map<number, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();

  add(geo: THREE.BufferGeometry, color: number, matrix: THREE.Matrix4, shadow = true) {
    let p = this.parts.get(color);
    if (!p) {
      p = { mat: lambert(color), geos: [], shadow };
      this.parts.set(color, p);
    }
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    g.deleteAttribute('uv');
    p.geos.push(g);
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotY = 0, shadow = true) {
    const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), color, m, shadow);
  }

  build(group: THREE.Group) {
    for (const p of this.parts.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(p.geos), p.mat);
      mesh.castShadow = p.shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
}

export function buildWorld(seed: number): THREE.Group {
  const rand = createRng(seed);
  const group = new THREE.Group();
  const b = new Batcher();

  // 地面（塀の外側の土・庭）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 200), lambert(0xa9b77a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, 55);
  ground.receiveShadow = true;
  group.add(ground);

  // 舗装面（重なりは少しずつ高さをずらしてちらつきを防ぐ）
  PAVED.forEach((r, i) => {
    const color = r === MAIN_ROAD ? 0x6a6764 : 0x77736e;
    const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition((r.x0 + r.x1) / 2, i * 0.0005, (r.z0 + r.z1) / 2);
    b.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), color, m, false);
  });

  buildRoadMarkings(b);
  buildGutters(b);
  buildWalls(b);
  buildGrassLot(b, rand);
  buildHouses(b, rand);
  buildSchool(b);
  buildHome(b);
  buildPoles(b);

  b.build(group);
  return group;
}

const flat = (b: Batcher, r: Rect, y: number, color: number) => {
  const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2);
  b.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), color, m, false);
};

function buildRoadMarkings(b: Batcher) {
  const white = 0xeeeae0;
  const y = 0.004;
  // 道A・路地の路側線（側溝の内側）
  flat(b, { x0: -2.65, x1: -2.55, z0: -4, z1: 28 }, y, white);
  flat(b, { x0: 2.55, x1: 2.65, z0: -4, z1: 28 }, y, white);
  flat(b, { x0: -2.65, x1: -2.55, z0: 33, z1: 62 }, y, white);
  flat(b, { x0: 2.55, x1: 2.65, z0: 33, z1: 62 }, y, white);

  // 抜け道の「止まれ」の代わりの停止線（道Aの手前）と矢印
  flat(b, { x0: -2.6, x1: 2.6, z0: 26.9, z1: 27.15 }, y, white);
  for (let x = -40; x <= 40; x += 16) {
    flat(b, { x0: x, x1: x + 1.6, z0: 30.42, z1: 30.58 }, y, white);
    const tri = new THREE.Shape([new THREE.Vector2(0, 0.45), new THREE.Vector2(0, -0.45), new THREE.Vector2(0.8, 0)]);
    const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x + 1.6, y, 30.5);
    b.add(new THREE.ShapeGeometry(tri), white, m, false);
  }

  // 大通り：センターライン・停止線・横断歩道
  for (let x = -60; x < 60; x += 4) {
    if (x > -6 && x < 4) continue;
    flat(b, { x0: x, x1: x + 2.4, z0: 65.92, z1: 66.08 }, y, 0xe8c34a);
  }
  flat(b, { x0: -4.7, x1: -4.4, z0: 62.3, z1: 65.9 }, y, white);
  flat(b, { x0: 4.4, x1: 4.7, z0: 66.1, z1: 69.7 }, y, white);
  for (let x = -2.9; x < 2.9; x += 0.9) {
    flat(b, { x0: x, x1: x + 0.45, z0: 62.4, z1: 69.6 }, y, white);
  }
}

function buildGutters(b: Batcher) {
  for (const g of GUTTERS) {
    const r = g.rect;
    const alongZ = r.z1 - r.z0 > r.x1 - r.x0;
    // ふたのない部分：暗い溝と縁石
    flat(b, r, 0.002, 0x34332f);
    const edge = alongZ
      ? [{ ...r, x1: r.x0 + 0.06 }, { ...r, x0: r.x1 - 0.06 }]
      : [{ ...r, z1: r.z0 + 0.06 }, { ...r, z0: r.z1 - 0.06 }];
    for (const e of edge) flat(b, e, 0.003, 0xb9b3a6);
    // 水の筋
    const w = alongZ
      ? { x0: (r.x0 + r.x1) / 2 - 0.06, x1: (r.x0 + r.x1) / 2 + 0.06, z0: r.z0, z1: r.z1 }
      : { x0: r.x0, x1: r.x1, z0: (r.z0 + r.z1) / 2 - 0.06, z1: (r.z0 + r.z1) / 2 + 0.06 };
    flat(b, w, 0.0025, 0x55626a);

    // ふた：1枚ずつ並べる
    for (const lid of g.lids) {
      const len = alongZ ? lid.z1 - lid.z0 : lid.x1 - lid.x0;
      const n = Math.max(1, Math.round(len));
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const piece = alongZ
          ? { x0: lid.x0, x1: lid.x1, z0: lid.z0 + (lid.z1 - lid.z0) * t0 + 0.01, z1: lid.z0 + (lid.z1 - lid.z0) * t1 - 0.01 }
          : { x0: lid.x0 + (lid.x1 - lid.x0) * t0 + 0.01, x1: lid.x0 + (lid.x1 - lid.x0) * t1 - 0.01, z0: lid.z0, z1: lid.z1 };
        b.box(piece.x1 - piece.x0, 0.03, piece.z1 - piece.z0, 0x9d9a92, (piece.x0 + piece.x1) / 2, 0.015, (piece.z0 + piece.z1) / 2, 0, false);
      }
    }
  }
}

function buildWalls(b: Batcher) {
  for (const w of WALLS) {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const cx = (w.x1 + w.x2) / 2 + w.nx * 0.075;
    const cz = (w.z1 + w.z2) / 2 + w.nz * 0.075;
    const rot = Math.atan2(w.x2 - w.x1, w.z2 - w.z1);
    // 少し長くして角の継ぎ目を埋める
    b.box(0.15, 1.2, len + 0.15, 0xc9c0ad, cx, 0.6, cz, rot);
    b.box(0.2, 0.06, len + 0.2, 0xa79f8f, cx, 1.23, cz, rot);
  }
}

function buildGrassLot(b: Batcher, rand: () => number) {
  const r = GRASS_LOT;
  flat(b, r, 0.003, 0x7d9a4c);
  const blade = new THREE.ConeGeometry(0.22, 1, 4);
  for (let i = 0; i < 260; i++) {
    const x = r.x0 + rand() * (r.x1 - r.x0 - 0.1);
    const z = r.z0 + rand() * (r.z1 - r.z0);
    const h = 0.5 + rand() * 0.7;
    const m = new THREE.Matrix4().makeScale(1, h, 1).setPosition(x, h / 2, z);
    b.add(blade, rand() < 0.5 ? 0x6f8f43 : 0x86a552, m);
  }
  // 草むらの手前の目印（立入禁止の杭とロープ）
  for (let z = r.z0 + 0.5; z <= r.z1; z += 2.5) b.box(0.08, 0.7, 0.08, 0xd8d0c0, r.x1 - 0.05, 0.35, z);
  b.box(0.02, 0.02, r.z1 - r.z0 - 1, 0xc0503a, r.x1 - 0.05, 0.6, (r.z0 + r.z1) / 2, 0, false);
}

/** 塀の外側に家を並べる。道や他の家と重なる場所は飛ばす。 */
function buildHouses(b: Batcher, rand: () => number) {
  const houseColors = [0xe9dcc4, 0xd8c7a8, 0xf0e6d6, 0xc7b79c, 0xe2d2bd];
  const roofColors = [0x5d6b7a, 0x8a4b3c, 0x4f5a4c, 0x6a5848];
  const placed: Rect[] = [GRASS_LOT, homeLot(), { x0: -14, x1: 14, z0: -20, z1: -4 }];
  const blocked = (r: Rect) =>
    PAVED.some((p) => overlaps(p, r, 0.3)) || placed.some((p) => overlaps(p, r, 0.4));

  for (const w of WALLS) {
    if (!w.houses) continue;
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const ux = (w.x2 - w.x1) / len;
    const uz = (w.z2 - w.z1) / len;
    let t = 1 + rand() * 3;
    while (t < len - 4) {
      const width = 5 + rand() * 3;
      const depth = 5 + rand() * 2;
      const h = 2.6 + rand() * 1.4;
      const off = 2.0 + rand() + depth / 2;
      const cx = w.x1 + ux * (t + width / 2) + w.nx * off;
      const cz = w.z1 + uz * (t + width / 2) + w.nz * off;
      // 道に沿った向きの外接矩形
      const hx = Math.abs(ux) * width / 2 + Math.abs(w.nx) * depth / 2;
      const hz = Math.abs(uz) * width / 2 + Math.abs(w.nz) * depth / 2;
      const r = { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz };
      if (!blocked(r) && Math.abs(cx) < 70 && cz < 135) {
        placed.push(r);
        const rot = Math.atan2(ux, uz);
        b.box(depth, h, width, houseColors[Math.floor(rand() * houseColors.length)], cx, h / 2, cz, rot);
        const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.78, 1.6, 4);
        roof.rotateY(Math.PI / 4);
        roof.scale(depth / Math.max(width, depth), 1, width / Math.max(width, depth));
        b.add(roof, roofColors[Math.floor(rand() * roofColors.length)], new THREE.Matrix4().makeRotationY(rot).setPosition(cx, h + 0.8, cz));
        // 庭木
        if (rand() < 0.55) {
          const tx = w.x1 + ux * (t + rand() * width) + w.nx * 0.9;
          const tz = w.z1 + uz * (t + rand() * width) + w.nz * 0.9;
          addTree(b, rand, tx, tz);
        }
      }
      t += width + 1.5 + rand() * 3;
    }
  }
}

function addTree(b: Batcher, rand: () => number, x: number, z: number) {
  b.add(new THREE.CylinderGeometry(0.08, 0.12, 1.4, 6), 0x7a5b3e, new THREE.Matrix4().setPosition(x, 0.7, z));
  const s = 0.9 + rand() * 0.6;
  b.add(new THREE.IcosahedronGeometry(s, 0), rand() < 0.5 ? 0x6f8f4e : 0x7f9d55, new THREE.Matrix4().setPosition(x, 1.4 + s * 0.7, z));
}

function buildSchool(b: Batcher) {
  b.box(22, 7, 6, 0xe6e0d2, 0, 3.5, ROAD_A.z0 - 10);
  const clock = new THREE.CylinderGeometry(0.7, 0.7, 0.1, 16);
  clock.rotateX(Math.PI / 2);
  b.add(clock, 0xffffff, new THREE.Matrix4().setPosition(0, 5.6, ROAD_A.z0 - 6.9), false);
}

const homeLot = (): Rect => ({ x0: HOME_GATE_X - 4, x1: HOME_GATE_X + 4, z0: HOME_ROAD.z1, z1: HOME_ROAD.z1 + 9 });

function buildHome(b: Batcher) {
  const cz = HOME_ROAD.z1 + 5.2;
  b.box(6.4, 3.2, 6, 0xf2e2c4, HOME_GATE_X, 1.6, cz);
  const roof = new THREE.ConeGeometry(4.8, 1.8, 4);
  roof.rotateY(Math.PI / 4);
  b.add(roof, 0xb5523b, new THREE.Matrix4().setPosition(HOME_GATE_X, 4.1, cz));
  b.box(1.0, 1.9, 0.1, 0x7a5236, HOME_GATE_X, 0.95, cz - 3.01, 0, false);
  // 門柱と門扉
  for (const dx of [-1, 1]) b.box(0.3, 1.5, 0.3, 0x8f8577, HOME_GATE_X + dx * 1.35, 0.75, HOME_ROAD.z1 + 0.1);
  b.box(2.4, 0.9, 0.05, 0x5b5148, HOME_GATE_X, 0.6, HOME_ROAD.z1 + 0.12);
  // 玄関マット（ゴール）
  flat(b, HOME_MAT, 0.005, 0xd9a35a);
}

function buildPoles(b: Batcher) {
  for (const p of POLES) {
    b.add(new THREE.CylinderGeometry(0.12, 0.16, 8, 8), 0x8e8a84, new THREE.Matrix4().setPosition(p.x, 4, p.z));
    b.box(1.4, 0.08, 0.08, 0x8e8a84, p.x, 7.4, p.z, p.x === POLES[3].x ? Math.PI / 2 : 0);
  }
  // 抜け道の角のカーブミラー（見通しの悪さの目印）
  for (const [x, z] of [[3.6, 27.4], [-3.6, 33.6]] as const) {
    b.add(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), 0xd76a3a, new THREE.Matrix4().setPosition(x, 1.3, z));
    const mirror = new THREE.CylinderGeometry(0.35, 0.35, 0.06, 12);
    mirror.rotateX(Math.PI / 2);
    b.add(mirror, 0xd76a3a, new THREE.Matrix4().makeRotationY(x > 0 ? -0.6 : Math.PI - 0.6).setPosition(x, 2.6, z));
  }
}

const overlaps = (a: Rect, r: Rect, m: number) => a.x0 - m < r.x1 && a.x1 + m > r.x0 && a.z0 - m < r.z1 && a.z1 + m > r.z0;
