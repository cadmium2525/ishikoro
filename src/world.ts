import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { CURB_HEIGHT, type Decor, type Level, type Rect, type WallSeg } from './level';

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

/** 家を並べるのは帰り道からこの距離まで（遠くは霧で見えない） */
const HOUSE_RANGE = 48;

export function buildWorld(level: Level): THREE.Group {
  const rand = createRng(level.seed ^ 0x2545f491);
  const group = new THREE.Group();
  const b = new Batcher();
  const B = level.bounds;

  // 地面（塀の外側の土・庭）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(B.x1 - B.x0 + 60, B.z1 - B.z0 + 60), lambert(0xa9b77a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((B.x0 + B.x1) / 2, -0.01, (B.z0 + B.z1) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // 車道と路地（重なりは少しずつ高さをずらしてちらつきを防ぐ）
  level.roadways.forEach((r, i) => {
    const lane = level.lanes.includes(r);
    flat(b, r, (lane ? 0.0004 : 0.0012) + (i % 4) * 0.0001, lane ? 0x7d7972 : 0x6e6a65);
  });
  // 坂：路地の上に、高さに沿った路面を重ねる
  for (const sl of level.slopes) {
    const len = sl.s1 - sl.s0;
    const geo = new THREE.PlaneGeometry(sl.half * 2, len, 1, Math.ceil(len / 1.5));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getZ(i) + len / 2) / len;
      pos.setY(i, sl.height * Math.sin(Math.PI * t) + 0.006);
    }
    geo.computeVertexNormals();
    const m = new THREE.Matrix4().makeRotationY(sl.axis === 'z' ? 0 : Math.PI / 2).setPosition(sl.axis === 'z' ? sl.c : (sl.s0 + sl.s1) / 2, 0, sl.axis === 'z' ? (sl.s0 + sl.s1) / 2 : sl.c);
    b.add(geo, 0x837e77, m, false);
  }
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
  buildWalls(b, level, level.walls);
  for (const d of level.decor) buildDecor(b, level, d, rand);
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

/** 区間 [a, b] から穴を除いた残り */
function spans(a: number, b: number, holes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cur = a;
  for (const [h0, h1] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (h1 <= cur || h0 >= b) continue;
    if (h0 > cur) out.push([cur, Math.min(h0, b)]);
    cur = Math.max(cur, h1);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

function buildRoadMarkings(b: Batcher, level: Level) {
  const white = 0xeeeae0;
  const y = 0.004;
  const streets = level.streets;
  for (const road of level.carRoads) {
    const s = streets.find((t) => t.axis === road.axis && t.c === road.c)!;
    const cross = streets.filter((t) => t.axis !== road.axis);
    // 交差点（交わる通りの幅）では線を引かない
    const holes = cross.map((t) => [t.c - t.outer - 0.3, t.c + t.outer + 0.3] as [number, number]);
    const band = (b0: number, b1: number, a0: number, a1: number): Rect =>
      road.axis === 'z' ? { x0: b0, x1: b1, z0: a0, z1: a1 } : { x0: a0, x1: a1, z0: b0, z1: b1 };
    for (const [a0, a1] of spans(s.s0, s.s1, holes)) {
      // 路肩の L 字溝と外側線
      for (const side of [-1, 1]) {
        const e = s.c + side * s.half;
        flat(b, band(Math.min(e, e - side * 0.4), Math.max(e, e - side * 0.4), a0, a1), 0.003, 0xb5b0a5);
        const l = s.c + side * (s.half - 0.5);
        flat(b, band(l - 0.06, l + 0.06, a0, a1), y, white);
      }
      // センターライン（破線）
      for (let a = a0; a < a1; a += 6) flat(b, band(s.c - 0.06, s.c + 0.06, a, Math.min(a1, a + 3)), y, white);
    }
    // 停止線
    for (const lane of road.lanes) {
      for (const stop of lane.stops) {
        const at = stop.at + lane.dir * 0.3;
        flat(b, band(lane.c - s.half / 2 + 0.15, lane.c + s.half / 2 - 0.15, at - 0.15, at + 0.15), y, white);
      }
    }
  }
  // 横断歩道。白線は車の進む向きに長く、渡る向きに並ぶ（はしご状）
  for (const c of level.crosswalks) {
    const r = c.rect;
    if (c.roadAxis === 'z') {
      for (let x = r.x0 + 0.35; x < r.x1 - 0.3; x += 0.9) flat(b, { x0: x, x1: x + 0.45, z0: r.z0 + 0.1, z1: r.z1 - 0.1 }, y + 0.001, white);
    } else {
      for (let z = r.z0 + 0.35; z < r.z1 - 0.3; z += 0.9) flat(b, { x0: r.x0 + 0.1, x1: r.x1 - 0.1, z0: z, z1: z + 0.45 }, y + 0.001, white);
    }
  }
  // 集水ます：格子のふた（格子は車道に沿った向き）
  for (const g of level.grates) {
    flat(b, g, 0.005, 0x2a2a28);
    const alongZ = g.z1 - g.z0 > g.x1 - g.x0;
    if (alongZ) for (let z = g.z0 + 0.08; z < g.z1 - 0.05; z += 0.12) flat(b, { x0: g.x0 + 0.03, x1: g.x1 - 0.03, z0: z, z1: z + 0.04 }, 0.006, 0x77736c);
    else for (let x = g.x0 + 0.08; x < g.x1 - 0.05; x += 0.12) flat(b, { x0: x, x1: x + 0.04, z0: g.z0 + 0.03, z1: g.z1 - 0.03 }, 0.006, 0x77736c);
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

function buildWalls(b: Batcher, level: Level, walls: WallSeg[]) {
  for (const w of walls) {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    if (len < 0.05 || w.style === 'none') continue;
    const rot = Math.atan2(w.x2 - w.x1, w.z2 - w.z1);
    const ux = (w.x2 - w.x1) / len;
    const uz = (w.z2 - w.z1) / len;
    // 坂の脇の塀は、路面の高さに合わせて段々に積む
    const onSlope = level.slopes.some((sl) => {
      const across = sl.axis === 'z' ? (w.x1 + w.x2) / 2 : (w.z1 + w.z2) / 2;
      const a0 = sl.axis === 'z' ? Math.min(w.z1, w.z2) : Math.min(w.x1, w.x2);
      const a1 = sl.axis === 'z' ? Math.max(w.z1, w.z2) : Math.max(w.x1, w.x2);
      return Math.abs(Math.abs(across - sl.c) - sl.half) < 0.02 && a1 > sl.s0 && a0 < sl.s1;
    });
    const pieces = onSlope ? Math.ceil(len / 1.5) : 1;
    for (let i = 0; i < pieces; i++) {
      const pl = len / pieces;
      const mx = w.x1 + ux * pl * (i + 0.5);
      const mz = w.z1 + uz * pl * (i + 0.5);
      const base = onSlope ? level.terrainAt(mx - w.nx * 0.05, mz - w.nz * 0.05) : 0;
      const cx = mx + w.nx * 0.075;
      const cz = mz + w.nz * 0.075;
      switch (w.style) {
        case 'fence': {
          // 公園や校庭の低い柵：支柱と横棒
          b.box(0.05, 0.05, pl, 0x5f7a66, cx, base + 0.85, cz, rot);
          b.box(0.05, 0.05, pl, 0x5f7a66, cx, base + 0.35, cz, rot);
          for (let t = 0; t <= pl; t += 1.5) {
            b.box(0.07, 0.95, 0.07, 0x5f7a66, w.x1 + ux * (pl * i + t) + w.nx * 0.075, base + 0.475, w.z1 + uz * (pl * i + t) + w.nz * 0.075);
          }
          break;
        }
        case 'hedge':
          b.box(0.4, 0.7, pl, 0x6f8f4e, mx + w.nx * 0.2, base + 0.35, mz + w.nz * 0.2, rot);
          break;
        case 'shop':
          // 店先は店の建物（buildDecor）が壁になる。足元の縁石だけ
          b.box(0.15, 0.25, pl, 0xa79f8f, cx, base + 0.125, cz, rot);
          break;
        default: {
          // 少し長くして角の継ぎ目を埋める。坂の脇は下まで埋める
          const h = 1.2 + base;
          b.box(0.15, h, pl + 0.15, 0xc9c0ad, cx, h / 2, cz, rot);
          b.box(0.2, 0.06, pl + 0.2, 0xa79f8f, cx, h + 0.03, cz, rot);
        }
      }
    }
  }
}

/** 区画の辺に沿って並べるときの向き（u：辺に沿う、n：通りへ向かう外向き） */
const faceFrame = (d: Decor) => {
  const nx = d.nx ?? 0;
  const nz = d.nz ?? 0;
  return { nx, nz, ux: nz !== 0 ? 1 : 0 };
};

function buildDecor(b: Batcher, level: Level, d: Decor, rand: () => number) {
  const r = d.rect;
  const near = nearRoute(level, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, Math.max(r.x1 - r.x0, r.z1 - r.z0) / 2 + 20);
  switch (d.kind) {
    case 'school': {
      // 校舎は区画のまん中に、長い辺を区画の長い方へ
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      const alongZ = r.z1 - r.z0 > r.x1 - r.x0;
      b.box(alongZ ? 7 : 20, 7, alongZ ? 20 : 7, 0xe6e0d2, cx, 3.5, cz);
      // 時計は学校を出る道の側に
      const dx = level.start.x - cx;
      const dz = level.start.z - cz;
      const clock = new THREE.CylinderGeometry(0.7, 0.7, 0.1, 16);
      clock.rotateX(Math.PI / 2);
      if (Math.abs(dx) > Math.abs(dz)) {
        clock.rotateY(Math.PI / 2);
        b.add(clock, 0xffffff, new THREE.Matrix4().setPosition(cx + Math.sign(dx) * ((alongZ ? 3.5 : 10) + 0.05), 5.6, cz), false);
      } else {
        b.add(clock, 0xffffff, new THREE.Matrix4().setPosition(cx, 5.6, cz + Math.sign(dz) * ((alongZ ? 10 : 3.5) + 0.05)), false);
      }
      flat(b, { x0: r.x0 + 0.5, x1: r.x1 - 0.5, z0: r.z0 + 0.5, z1: r.z1 - 0.5 }, 0.002, 0xc9b48a);
      break;
    }
    case 'shops': {
      // 通りに面して間口 4〜6 m の店を並べる。歩道の上に日よけ
      const { nx, nz, ux } = faceFrame(d);
      const colors = [0xe8d7b8, 0xd9c09a, 0xcfd6d0, 0xe6c7c0, 0xd6d0b8];
      const awnings = [0xc0503a, 0x3f7a6a, 0xd9a35a, 0x55709a, 0x8a5a8a];
      // 店の並ぶ辺（通り側の縁）。箱のローカル +X を通りの向き（n）へ回す
      const faceC = nx > 0 ? r.x1 : nx < 0 ? r.x0 : nz > 0 ? r.z1 : r.z0;
      const a0 = ux ? r.x0 : r.z0;
      const a1 = ux ? r.x1 : r.z1;
      const rot = Math.atan2(-nz, nx);
      for (let a = a0; a < a1 - 1; ) {
        const wdt = Math.min(a1 - a, 4 + rand() * 2);
        const h = 3.4 + rand() * 1.4;
        const am = a + wdt / 2;
        const at = (off: number): [number, number] => (ux ? [am, faceC - nz * off] : [faceC - nx * off, am]);
        const [bx, bz] = at(3.1);
        b.box(6, h, wdt - 0.15, colors[Math.floor(rand() * colors.length)], bx, h / 2, bz, rot);
        // ガラスの店先、通りへ下がる日よけ、看板
        const [gx, gz] = at(0.08);
        b.box(0.05, 1.8, wdt - 1.0, 0x8fa4ad, gx, 1.15, gz, rot, false);
        const aw = new THREE.BoxGeometry(0.7, 0.05, wdt - 0.6);
        aw.rotateZ(-0.4);
        const [wx, wz] = at(-0.28);
        b.add(aw, awnings[Math.floor(rand() * awnings.length)], new THREE.Matrix4().makeRotationY(rot).setPosition(wx, 2.7, wz));
        const [sx, sz] = at(0.05);
        b.box(0.1, 0.5, wdt * 0.6, 0xf4efe4, sx, h - 0.6, sz, rot, false);
        a += wdt;
      }
      break;
    }
    case 'paddy': {
      // 水を張った田んぼと稲の列、あぜ
      flat(b, r, 0.004, 0x86b3b5);
      if (!near) break;
      const rice = new THREE.ConeGeometry(0.12, 0.45, 4);
      const w = r.x1 - r.x0;
      const h = r.z1 - r.z0;
      const step = Math.max(0.6, Math.sqrt((w * h) / 1400));
      for (let x = r.x0 + 0.5; x < r.x1 - 0.3; x += step) {
        for (let z = r.z0 + 0.4; z < r.z1 - 0.3; z += step * 0.85) b.add(rice, 0x8fae4f, new THREE.Matrix4().setPosition(x, 0.2, z), false);
      }
      // あぜ（田んぼの外周）
      for (const e of [{ ...r, x1: r.x0 + 0.3 }, { ...r, x0: r.x1 - 0.3 }, { ...r, z1: r.z0 + 0.3 }, { ...r, z0: r.z1 - 0.3 }]) flat(b, e, 0.012, 0x9a8a5c);
      break;
    }
    case 'park': {
      flat(b, r, 0.003, 0x8bb06a);
      if (!near) break;
      // 柵ぞいの植え込み、木、ベンチ、すべり台
      const shrub = new THREE.IcosahedronGeometry(0.45, 0);
      for (let x = r.x0 + 1; x < r.x1 - 1; x += 1.3) {
        b.add(shrub, 0x5f8a45, new THREE.Matrix4().setPosition(x, 0.35, r.z0 + 0.9));
        b.add(shrub, 0x5f8a45, new THREE.Matrix4().setPosition(x, 0.35, r.z1 - 0.9));
      }
      for (let z = r.z0 + 2.2; z < r.z1 - 2.2; z += 1.3) {
        b.add(shrub, 0x5f8a45, new THREE.Matrix4().setPosition(r.x0 + 0.9, 0.35, z));
        b.add(shrub, 0x5f8a45, new THREE.Matrix4().setPosition(r.x1 - 0.9, 0.35, z));
      }
      for (let i = 0; i < 6; i++) addTree(b, rand, r.x0 + 4 + rand() * (r.x1 - r.x0 - 8), r.z0 + 4 + rand() * (r.z1 - r.z0 - 8));
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      b.box(0.5, 0.45, 1.6, 0x9a6b44, cx + 4, 0.25, cz + 3);
      b.box(1.2, 1.6, 0.8, 0xd65a3c, cx - 3, 0.8, cz - 2);
      const slide = new THREE.BoxGeometry(0.7, 0.08, 3);
      slide.rotateX(0.5);
      b.add(slide, 0xe8c34a, new THREE.Matrix4().setPosition(cx - 3, 0.8, cz - 0.5));
      break;
    }
    case 'lot': {
      flat(b, r, 0.003, 0x7d9a4c);
      if (!near) break;
      // 背の高い草。帰り道に近い縁ほど多く
      const blade = new THREE.ConeGeometry(0.22, 1, 4);
      for (let i = 0; i < 900; i++) {
        const x = r.x0 + 0.1 + rand() * (r.x1 - r.x0 - 0.2);
        const z = r.z0 + 0.1 + rand() * (r.z1 - r.z0 - 0.2);
        if (!nearRoute(level, x, z, 12)) continue;
        const h = 0.5 + rand() * 0.7;
        b.add(blade, rand() < 0.5 ? 0x6f8f43 : 0x86a552, new THREE.Matrix4().makeScale(1, h, 1).setPosition(x, h / 2, z));
      }
      break;
    }
  }
}

/** 帰り道（中心線）から dist 以内か */
function nearRoute(level: Level, x: number, z: number, dist: number): boolean {
  const r = level.route;
  for (let i = 0; i < r.length - 1; i++) {
    const [ax, az] = r[i];
    const [bx, bz] = r[i + 1];
    const sx = bx - ax;
    const sz = bz - az;
    const l2 = sx * sx + sz * sz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / l2));
    if (Math.hypot(ax + sx * t - x, az + sz * t - z) < dist) return true;
  }
  return false;
}

/** 歩道の自転車と立て看板 */
function buildBlocks(b: Batcher, level: Level) {
  const wheel = new THREE.TorusGeometry(0.3, 0.035, 5, 12);
  wheel.rotateY(Math.PI / 2);
  for (const r of level.blocks) {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const alongZ = r.z1 - r.z0 >= r.x1 - r.x0;
    const long = Math.max(r.z1 - r.z0, r.x1 - r.x0);
    const rot = alongZ ? 0 : Math.PI / 2;
    const off = (d: number): [number, number] => (alongZ ? [cx, cz + d] : [cx + d, cz]);
    if (long > 1) {
      // 自転車（塀に沿って停めてある）
      for (const d of [-0.55, 0.55]) {
        const [x, z] = off(d);
        b.add(wheel, 0x2a2a2a, new THREE.Matrix4().makeRotationY(rot).setPosition(x, CURB_HEIGHT + 0.3, z));
      }
      b.box(0.05, 0.05, 1.0, 0x3f6e8a, cx, CURB_HEIGHT + 0.5, cz, rot);
      const [sx, sz] = off(-0.25);
      b.box(0.05, 0.5, 0.05, 0x3f6e8a, sx, CURB_HEIGHT + 0.5, sz);
      const [tx, tz] = off(-0.3);
      b.box(0.12, 0.05, 0.25, 0x222222, tx, CURB_HEIGHT + 0.78, tz, rot);
      const [hx, hz] = off(0.45);
      b.box(0.45, 0.04, 0.04, 0x888888, hx, CURB_HEIGHT + 0.83, hz, rot);
    } else {
      // 立て看板
      b.box(0.08, 0.85, 0.45, 0xf4efe4, cx, CURB_HEIGHT + 0.45, cz, rot);
      b.box(0.09, 0.5, 0.38, 0xc0503a, cx, CURB_HEIGHT + 0.55, cz, rot, false);
    }
  }
}

/** 塀の外側に家を並べる。道や他の家と重なる場所、帰り道から遠い場所は飛ばす。 */
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
      if (!blocked(r) && nearRoute(level, cx, cz, HOUSE_RANGE)) {
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

/** 主人公の家。色や形は家ごとに変わる。門から玄関までが通りから家の方（n）へ伸びる */
function buildHome(b: Batcher, level: Level) {
  const home = level.home;
  const rand = createRng(home.seed);
  const walls = [0xf2e2c4, 0xe9d3c0, 0xdfe3e6, 0xf0ead8, 0xd9c8a8];
  const roofs = [0xb5523b, 0x4f5f78, 0x5a6b4c, 0x8a5a3c, 0x3d3f45];
  const { gx, gz, nx, nz } = home;
  // 家の向き：ローカルの +Z が通りから家の奥へ
  const rot = Math.atan2(nx, nz);
  const at = (along: number, depth: number): [number, number] => [gx + nx * depth + nz * along, gz + nz * depth - nx * along];
  const h = 3.0 + rand() * 1.6;
  const wdt = 6 + rand() * 1.2;
  const [hx, hz] = at(0, 5.2);
  b.box(wdt, h, 6, walls[Math.floor(rand() * walls.length)], hx, h / 2, hz, rot);
  const roof = new THREE.ConeGeometry(wdt * 0.75, 1.8, 4);
  roof.rotateY(Math.PI / 4);
  b.add(roof, roofs[Math.floor(rand() * roofs.length)], new THREE.Matrix4().makeRotationY(rot).setPosition(hx, h + 0.9, hz));
  const [dx, dz] = at(0, 2.19);
  b.box(1.0, 1.9, 0.1, 0x7a5236, dx, 0.95, dz, rot, false);
  // 窓と郵便受け
  const [wx, wz] = at(rand() < 0.5 ? -1.9 : 1.9, 2.19);
  b.box(1.2, 0.8, 0.06, 0x9fb4bf, wx, 1.6, wz, rot, false);
  const [mx, mz] = at(1.55, 0.1);
  b.box(0.3, 0.25, 0.2, 0xc0503a, mx, 1.0, mz, rot);
  // 門柱（門は開いている）
  for (const s of [-1.35, 1.35]) {
    const [px, pz] = at(s, 0.1);
    b.box(0.3, 1.5, 0.3, 0x8f8577, px, 0.75, pz);
  }
  // 門の前から玄関まで（ゴール）と飛び石
  flat(b, home.mat, 0.005, 0xd9a35a);
  for (let d = 0.4; d < 2.0; d += 0.7) {
    const [sx, sz] = at(0, d);
    b.box(0.7, 0.02, 0.45, 0xb8b0a0, sx, 0.012, sz, rot, false);
  }
}

function buildPoles(b: Batcher, level: Level) {
  for (const p of level.poles) {
    // 腕木は通りを横切る向き
    const area = level.lanes.find((r) => inside(r, p.x, p.z)) ?? level.sidewalks.find((r) => inside(r, p.x, p.z));
    const alongZ = area ? area.z1 - area.z0 > area.x1 - area.x0 : true;
    const base = level.terrainAt(p.x, p.z);
    b.add(new THREE.CylinderGeometry(0.12, 0.16, 8, 8), 0x8e8a84, new THREE.Matrix4().setPosition(p.x, base + 4, p.z));
    b.box(1.4, 0.08, 0.08, 0x8e8a84, p.x, base + 7.4, p.z, alongZ ? 0 : Math.PI / 2);
  }
}

const inside = (r: Rect, x: number, z: number) => x >= r.x0 - 0.2 && x <= r.x1 + 0.2 && z >= r.z0 - 0.2 && z <= r.z1 + 0.2;
const overlaps = (a: Rect, r: Rect, m: number) => a.x0 - m < r.x1 && a.x1 + m > r.x0 && a.z0 - m < r.z1 && a.z1 + m > r.z0;
