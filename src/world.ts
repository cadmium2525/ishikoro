import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { CURB_HEIGHT, RA_X1, SW_X0, SW_X1, type Decor, type Level, type Rect, type WallSeg } from './level';

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
      for (const g of p.geos) g.dispose();
    }
  }
}

export function buildWorld(level: Level): THREE.Group {
  const rand = createRng(level.seed ^ 0x2545f491);
  const group = new THREE.Group();
  const b = new Batcher();
  const A = level.roadA;

  // 地面（塀の外側の土・庭）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, A.z1 - A.z0 + 80), lambert(0xa9b77a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-20, -0.01, (A.z0 + A.z1) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // 車道（重なりは少しずつ高さをずらしてちらつきを防ぐ）
  level.roadways.forEach((r, i) => {
    const color = r === A ? 0x726e69 : level.lanes.includes(r) ? 0x7d7972 : 0x6a6764;
    flat(b, r, 0.0005 + (i % 8) * 0.0004, color);
  });
  // 歩道：縁石の高さだけ持ち上げたタイル敷き
  for (const r of level.sidewalks) {
    b.box(r.x1 - r.x0, CURB_HEIGHT, r.z1 - r.z0, 0xcfc8ba, (r.x0 + r.x1) / 2, CURB_HEIGHT / 2, (r.z0 + r.z1) / 2, 0, false);
  }
  // 縁石の縁取り
  for (const c of level.curbs) {
    const len = Math.hypot(c.x2 - c.x1, c.z2 - c.z1);
    const rot = Math.atan2(c.x2 - c.x1, c.z2 - c.z1);
    b.box(0.14, CURB_HEIGHT + 0.006, len, 0xe2ddd2, (c.x1 + c.x2) / 2 - c.nx * 0.07, CURB_HEIGHT / 2 + 0.003, (c.z1 + c.z2) / 2 - c.nz * 0.07, rot, false);
  }
  // 切り下げ：歩道の縁を斜めに下げた部分
  for (const r of level.ramps) flat(b, r, CURB_HEIGHT + 0.004, 0xb9b2a4);

  buildRoadMarkings(b, level);
  buildGutters(b, level);
  buildWalls(b, level.walls);
  for (const d of level.decor) buildDecor(b, d, rand);
  buildBlocks(b, level);
  buildHouses(b, level, rand);
  buildHome(b, level);
  buildPoles(b, level);

  b.build(group);
  return group;
}

/** 前の通学路の形と材質を片付ける */
export function disposeWorld(group: THREE.Group) {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (m.material as THREE.Material).dispose();
  });
}

const flat = (b: Batcher, r: Rect, y: number, color: number) => {
  const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2);
  b.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), color, m, false);
};

function buildRoadMarkings(b: Batcher, level: Level) {
  const white = 0xeeeae0;
  const y = 0.004;
  const A = level.roadA;
  const crossings = level.intersections;
  const inCrossing = (z0: number, z1: number) => crossings.some((x) => z1 > x.rz0 - 1.2 && z0 < x.rz1 + 1.2);

  /** z 方向の線。交差点の中は引かない */
  const lineZ = (x: number, color: number, dash = 0, width = 0.12) => {
    const step = dash ? dash * 2 : 1;
    for (let z = A.z0; z < A.z1; z += step) {
      const e = Math.min(A.z1, z + (dash || step));
      if (!inCrossing(z, e)) flat(b, { x0: x - width / 2, x1: x + width / 2, z0: z, z1: e }, y, color);
    }
  };
  // 道A：路肩のL字溝、外側線、センターライン
  lineZ(A.x0 + 0.2, 0xb5b0a5, 0, 0.4);
  lineZ(A.x1 - 0.2, 0xb5b0a5, 0, 0.4);
  lineZ(A.x0 + 0.5, white);
  lineZ(A.x1 - 0.5, white);
  lineZ((A.x0 + A.x1) / 2, white, 3);

  for (const x of crossings) {
    const mid = (x.rz0 + x.rz1) / 2;
    // 大通り：センターライン（黄）と外側線。交差点の中は引かない
    for (const [from, to] of [[-70, SW_X0 - 1], [RA_X1 + 1, 70]]) {
      flat(b, { x0: from, x1: to, z0: mid - 0.06, z1: mid + 0.06 }, y, 0xe8c34a);
      flat(b, { x0: from, x1: to, z0: x.rz0 + 0.34, z1: x.rz0 + 0.46 }, y, white);
      flat(b, { x0: from, x1: to, z0: x.rz1 - 0.46, z1: x.rz1 - 0.34 }, y, white);
    }
    // 停止線
    flat(b, { x0: SW_X0 - 0.75, x1: SW_X0 - 0.45, z0: x.rz0 + 0.2, z1: mid - 0.1 }, y, white);
    flat(b, { x0: RA_X1 + 0.45, x1: RA_X1 + 0.75, z0: mid + 0.1, z1: x.rz1 - 0.2 }, y, white);
    flat(b, { x0: (A.x0 + A.x1) / 2 + 0.1, x1: A.x1 - 0.2, z0: x.rz0 - 0.75, z1: x.rz0 - 0.45 }, y, white);
    flat(b, { x0: A.x0 + 0.2, x1: (A.x0 + A.x1) / 2 - 0.1, z0: x.rz1 + 0.45, z1: x.rz1 + 0.75 }, y, white);
    // 横断歩道。白線は車の進む向きに長く、渡る向きに並ぶ（はしご状）
    for (let z = x.rz0 + 0.35; z < x.rz1 - 0.3; z += 0.9) {
      flat(b, { x0: SW_X0 + 0.1, x1: SW_X1 - 0.1, z0: z, z1: z + 0.45 }, y, white);
    }
  }

  // 集水ます：格子のふた
  for (const g of level.grates) {
    flat(b, g, 0.005, 0x2a2a28);
    for (let z = g.z0 + 0.08; z < g.z1 - 0.05; z += 0.12) flat(b, { x0: g.x0 + 0.03, x1: g.x1 - 0.03, z0: z, z1: z + 0.04 }, 0.006, 0x77736c);
  }
}

function buildGutters(b: Batcher, level: Level) {
  for (const g of level.gutters) {
    const r = g.rect;
    const alongZ = r.z1 - r.z0 > r.x1 - r.x0;
    // ふたのない部分：暗い溝と縁
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

function buildWalls(b: Batcher, walls: WallSeg[]) {
  for (const w of walls) {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    if (len < 0.05) continue;
    const rot = Math.atan2(w.x2 - w.x1, w.z2 - w.z1);
    const cx = (w.x1 + w.x2) / 2 + w.nx * 0.075;
    const cz = (w.z1 + w.z2) / 2 + w.nz * 0.075;
    switch (w.style) {
      case 'fence': {
        // 公園や校庭の低い柵：支柱と横棒
        b.box(0.05, 0.05, len, 0x5f7a66, cx, 0.85, cz, rot);
        b.box(0.05, 0.05, len, 0x5f7a66, cx, 0.35, cz, rot);
        const ux = (w.x2 - w.x1) / len;
        const uz = (w.z2 - w.z1) / len;
        for (let t = 0; t <= len; t += 1.5) b.box(0.07, 0.95, 0.07, 0x5f7a66, w.x1 + ux * t + w.nx * 0.075, 0.475, w.z1 + uz * t + w.nz * 0.075);
        break;
      }
      case 'hedge':
        b.box(0.4, 0.7, len, 0x6f8f4e, (w.x1 + w.x2) / 2 + w.nx * 0.2, 0.35, (w.z1 + w.z2) / 2 + w.nz * 0.2, rot);
        break;
      case 'shop':
        // 店先は店の建物（buildDecor）が壁になる。足元の縁石だけ
        b.box(0.15, 0.25, len, 0xa79f8f, cx, 0.125, cz, rot);
        break;
      default:
        // 少し長くして角の継ぎ目を埋める
        b.box(0.15, 1.2, len + 0.15, 0xc9c0ad, cx, 0.6, cz, rot);
        b.box(0.2, 0.06, len + 0.2, 0xa79f8f, cx, 1.23, cz, rot);
    }
  }
}

function buildDecor(b: Batcher, d: Decor, rand: () => number) {
  const r = d.rect;
  switch (d.kind) {
    case 'school': {
      b.box(6, 7, 18, 0xe6e0d2, r.x0 + 7, 3.5, (r.z0 + r.z1) / 2 - 3);
      const clock = new THREE.CylinderGeometry(0.7, 0.7, 0.1, 16);
      clock.rotateZ(Math.PI / 2);
      b.add(clock, 0xffffff, new THREE.Matrix4().setPosition(r.x0 + 10.05, 5.6, (r.z0 + r.z1) / 2 - 3), false);
      // 校庭の土
      flat(b, { x0: r.x0 + 10, x1: r.x1 - 0.1, z0: r.z0 + 2, z1: r.z1 }, 0.002, 0xc9b48a);
      break;
    }
    case 'shops': {
      // 間口 4〜6 m の店を並べる。歩道の上に日よけ
      const colors = [0xe8d7b8, 0xd9c09a, 0xcfd6d0, 0xe6c7c0, 0xd6d0b8];
      const awnings = [0xc0503a, 0x3f7a6a, 0xd9a35a, 0x55709a, 0x8a5a8a];
      for (let z = r.z0; z < r.z1 - 1; ) {
        const wdt = Math.min(r.z1 - z, 4 + rand() * 2);
        const h = 3.4 + rand() * 1.4;
        const cz = z + wdt / 2;
        b.box(6, h, wdt - 0.15, colors[Math.floor(rand() * colors.length)], r.x1 - 3.1, h / 2, cz);
        // ガラスの店先と日よけ
        b.box(0.05, 1.8, wdt - 1.0, 0x8fa4ad, r.x1 - 0.08, 1.15, cz, 0, false);
        const aw = new THREE.BoxGeometry(0.7, 0.05, wdt - 0.6);
        aw.rotateZ(-0.4);
        b.add(aw, awnings[Math.floor(rand() * awnings.length)], new THREE.Matrix4().setPosition(r.x1 + 0.28, 2.7, cz));
        // 看板
        b.box(0.1, 0.5, wdt * 0.6, 0xf4efe4, r.x1 - 0.05, h - 0.6, cz, 0, false);
        z += wdt;
      }
      break;
    }
    case 'paddy': {
      // 水を張った田んぼと稲の列、あぜ
      flat(b, r, 0.004, 0x86b3b5);
      const along = r.z1 - r.z0 >= r.x1 - r.x0 ? 'z' : 'x';
      const rice = new THREE.ConeGeometry(0.12, 0.45, 4);
      for (let u = 0.5; u < (along === 'z' ? r.x1 - r.x0 : r.z1 - r.z0) - 0.3; u += 0.6) {
        for (let v = 0.4; v < (along === 'z' ? r.z1 - r.z0 : r.x1 - r.x0) - 0.3; v += 0.5) {
          const x = along === 'z' ? r.x0 + u : r.x0 + v;
          const z = along === 'z' ? r.z0 + v : r.z0 + u;
          b.add(rice, 0x8fae4f, new THREE.Matrix4().setPosition(x, 0.2, z), false);
        }
      }
      // あぜ（田んぼの外周）
      for (const e of [{ ...r, x1: r.x0 + 0.3 }, { ...r, z1: r.z0 + 0.3 }, { ...r, z0: r.z1 - 0.3 }]) flat(b, e, 0.012, 0x9a8a5c);
      break;
    }
    case 'park': {
      flat(b, r, 0.003, 0x8bb06a);
      // 柵ぞいの植え込み、木、ベンチ、すべり台
      const fx = r.x1;
      for (let z = r.z0 + 1; z < r.z1 - 1; z += 1.2) b.add(new THREE.IcosahedronGeometry(0.45, 0), 0x5f8a45, new THREE.Matrix4().setPosition(fx - 0.9, 0.35, z));
      for (let i = 0; i < 5; i++) addTree(b, rand, r.x0 + 4 + rand() * (r.x1 - r.x0 - 8), r.z0 + 2 + rand() * (r.z1 - r.z0 - 4));
      const cz = (r.z0 + r.z1) / 2;
      b.box(0.5, 0.45, 1.6, 0x9a6b44, fx - 4, 0.25, cz + 3);
      b.box(1.2, 1.6, 0.8, 0xd65a3c, fx - 9, 0.8, cz - 2);
      const slide = new THREE.BoxGeometry(0.7, 0.08, 3);
      slide.rotateX(0.5);
      b.add(slide, 0xe8c34a, new THREE.Matrix4().setPosition(fx - 9, 0.8, cz - 0.5));
      break;
    }
    case 'lot': {
      flat(b, r, 0.003, 0x7d9a4c);
      const blade = new THREE.ConeGeometry(0.22, 1, 4);
      const n = Math.round((r.x1 - r.x0) * (r.z1 - r.z0) * 3.5);
      for (let i = 0; i < n; i++) {
        const x = r.x0 + rand() * (r.x1 - r.x0 - 0.1);
        const z = r.z0 + rand() * (r.z1 - r.z0);
        const h = 0.5 + rand() * 0.7;
        b.add(blade, rand() < 0.5 ? 0x6f8f43 : 0x86a552, new THREE.Matrix4().makeScale(1, h, 1).setPosition(x, h / 2, z));
      }
      // 草むらの手前の目印（杭とロープ）
      for (let z = r.z0 + 0.5; z <= r.z1; z += 2.5) b.box(0.08, 0.7, 0.08, 0xd8d0c0, r.x1 - 0.05, 0.35, z);
      b.box(0.02, 0.02, r.z1 - r.z0 - 1, 0xc0503a, r.x1 - 0.05, 0.6, (r.z0 + r.z1) / 2, 0, false);
      break;
    }
  }
}

/** 歩道の自転車と立て看板 */
function buildBlocks(b: Batcher, level: Level) {
  const wheel = new THREE.TorusGeometry(0.3, 0.035, 5, 12);
  wheel.rotateY(Math.PI / 2);
  for (const r of level.blocks) {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    if (r.z1 - r.z0 > 1) {
      // 自転車（塀に沿って停めてある）
      for (const dz of [-0.55, 0.55]) b.add(wheel, 0x2a2a2a, new THREE.Matrix4().setPosition(cx, 0.42, cz + dz));
      b.box(0.05, 0.05, 1.0, 0x3f6e8a, cx, 0.62, cz);
      b.box(0.05, 0.5, 0.05, 0x3f6e8a, cx, 0.62, cz - 0.25);
      b.box(0.12, 0.05, 0.25, 0x222222, cx, 0.9, cz - 0.3);
      b.box(0.45, 0.04, 0.04, 0x888888, cx, 0.95, cz + 0.45);
    } else {
      // 立て看板
      b.box(0.08, 0.85, 0.45, 0xf4efe4, cx, CURB_HEIGHT + 0.45, cz);
      b.box(0.09, 0.5, 0.38, 0xc0503a, cx + 0.01, CURB_HEIGHT + 0.55, cz, 0, false);
    }
  }
}

/** 塀の外側に家を並べる。道や他の家と重なる場所は飛ばす。 */
function buildHouses(b: Batcher, level: Level, rand: () => number) {
  const houseColors = [0xe9dcc4, 0xd8c7a8, 0xf0e6d6, 0xc7b79c, 0xe2d2bd];
  const roofColors = [0x5d6b7a, 0x8a4b3c, 0x4f5a4c, 0x6a5848];
  const placed: Rect[] = [...level.reserved];
  const blocked = (r: Rect) =>
    level.roadways.some((p) => overlaps(p, r, 0.3)) ||
    level.sidewalks.some((p) => overlaps(p, r, 0.3)) ||
    placed.some((p) => overlaps(p, r, 0.4));

  for (const w of level.walls) {
    if (!w.houses) continue;
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const ux = (w.x2 - w.x1) / len;
    const uz = (w.z2 - w.z1) / len;
    let t = 0.5 + rand() * 2;
    while (t < len - 3) {
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
      if (!blocked(r) && Math.abs(cx) < 75) {
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

/** 主人公の家。色や形は家ごとに変わる */
function buildHome(b: Batcher, level: Level) {
  const home = level.home;
  const rand = createRng(home.seed);
  const walls = [0xf2e2c4, 0xe9d3c0, 0xdfe3e6, 0xf0ead8, 0xd9c8a8];
  const roofs = [0xb5523b, 0x4f5f78, 0x5a6b4c, 0x8a5a3c, 0x3d3f45];
  const gx = home.gateX;
  const cz = home.wallZ + 5.2;
  const h = 3.0 + rand() * 1.6;
  const wdt = 6 + rand() * 1.2;
  b.box(wdt, h, 6, walls[Math.floor(rand() * walls.length)], gx, h / 2, cz);
  const roof = new THREE.ConeGeometry(wdt * 0.75, 1.8, 4);
  roof.rotateY(Math.PI / 4);
  b.add(roof, roofs[Math.floor(rand() * roofs.length)], new THREE.Matrix4().setPosition(gx, h + 0.9, cz));
  b.box(1.0, 1.9, 0.1, 0x7a5236, gx, 0.95, cz - 3.01, 0, false);
  // 窓と郵便受け
  b.box(1.2, 0.8, 0.06, 0x9fb4bf, gx + (rand() < 0.5 ? -1.9 : 1.9), 1.6, cz - 3.01, 0, false);
  b.box(0.3, 0.25, 0.2, 0xc0503a, home.porch.x1 + 0.2, 1.0, home.wallZ + 0.1);
  // 門柱（門は開いている）
  for (const x of [home.porch.x0 - 0.15, home.porch.x1 + 0.15]) b.box(0.3, 1.5, 0.3, 0x8f8577, x, 0.75, home.wallZ + 0.1);
  // 門の前から玄関まで（ゴール）と飛び石
  flat(b, home.mat, 0.005, 0xd9a35a);
  for (let z = home.porch.z0 + 0.4; z < home.porch.z1 - 0.2; z += 0.7) b.box(0.7, 0.02, 0.45, 0xb8b0a0, gx, 0.012, z, 0, false);
}

function buildPoles(b: Batcher, level: Level) {
  for (const p of level.poles) {
    // 腕木は道を横切る向き
    const lane = level.lanes.find((r) => p.x >= r.x0 - 0.2 && p.x <= r.x1 + 0.2 && p.z >= r.z0 - 0.2 && p.z <= r.z1 + 0.2);
    const acrossX = lane ? lane.z1 - lane.z0 > lane.x1 - lane.x0 : true;
    b.add(new THREE.CylinderGeometry(0.12, 0.16, 8, 8), 0x8e8a84, new THREE.Matrix4().setPosition(p.x, 4, p.z));
    b.box(1.4, 0.08, 0.08, 0x8e8a84, p.x, 7.4, p.z, acrossX ? 0 : Math.PI / 2);
  }
}

const overlaps = (a: Rect, r: Rect, m: number) => a.x0 - m < r.x1 && a.x1 + m > r.x0 && a.z0 - m < r.z1 && a.z1 + m > r.z0;
