/**
 * Phase 2 の固定通学路。描画（world.ts）・物理（stone.ts）・交通（traffic.ts）が共通で参照するデータ。
 *
 *   学校 → 住宅街の道A → 抜け道（一方通行・信号なし）→ 道A（空き地の草むら）
 *   → 大通り（信号つき横断歩道）→ 細い路地 → 右に曲がって → 家
 *
 * 座標は +Z が学校から家へ向かう方向。車道はすべて X 方向に走る。
 */

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** 石が跳ね返る塀。(nx, nz) は道の外側を向く法線 */
export interface WallSeg {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  nx: number;
  nz: number;
  /** 外側に家を並べるか */
  houses: boolean;
}

export interface Gutter {
  /** ふたのない部分も含めた側溝全体 */
  rect: Rect;
  /** ふたのかかっている区間（この上は安全） */
  lids: Rect[];
}

export interface PoleCollider {
  x: number;
  z: number;
  radius: number;
}

export interface CarLaneDef {
  /** 車線中心の z */
  z: number;
  dir: 1 | -1;
  /** 車が現れる x と消える x */
  xStart: number;
  xEnd: number;
  cruise: number;
  /** 出現間隔 [s] の範囲 */
  interval: [number, number];
  /** 信号待ちで車の先頭が止まる x */
  stopX?: number;
}

export interface CarRoad {
  rect: Rect;
  lanes: CarLaneDef[];
  /** 信号つき交差点があるか（大通りのみ） */
  signal: boolean;
}

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 });
const wall = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number, houses = true): WallSeg => ({ x1, z1, x2, z2, nx, nz, houses });

export const GUTTER_W = 0.45;

/** 道A（学校から大通りまで） */
export const ROAD_A = rect(-3.2, 3.2, -4, 62);
/** 抜け道（一方通行、信号なし） */
export const SIDE_STREET = rect(-55, 55, 28, 33);
/** 大通り（片側1車線、信号つき） */
export const MAIN_ROAD = rect(-60, 60, 62, 70);
/** 大通りの先の細い路地 */
export const ALLEY = rect(-2.2, 2.2, 70, 110);
/** 路地の突き当たりを右へ曲がった家の前の道 */
export const HOME_ROAD = rect(-40, 2.2, 104, 110);

/** 舗装面（描画用） */
export const PAVED: Rect[] = [ROAD_A, SIDE_STREET, MAIN_ROAD, ALLEY, HOME_ROAD];

/** 塀のない空き地。草むらに入った石は見つからない */
export const GRASS_LOT = rect(-12, -3.2, 44, 52);
/** 石の中心がここまで入ったら見失う */
export const GRASS_LOST = rect(-12, -3.4, 44, 52);

export const WALLS: WallSeg[] = [
  // 学校の門
  wall(-3.2, -4, 3.2, -4, 0, -1, false),
  // 道A 西側（空き地の部分は塀なし）
  wall(-3.2, -4, -3.2, 28, -1, 0),
  wall(-3.2, 33, -3.2, 44, -1, 0),
  wall(-3.2, 52, -3.2, 62, -1, 0),
  // 道A 東側
  wall(3.2, -4, 3.2, 28, 1, 0),
  wall(3.2, 33, 3.2, 62, 1, 0),
  // 抜け道の両側
  wall(-55, 28, -3.2, 28, 0, -1),
  wall(3.2, 28, 55, 28, 0, -1),
  wall(-55, 33, -3.2, 33, 0, 1),
  wall(3.2, 33, 55, 33, 0, 1),
  // 車道の先は町はずれ（石がどこまでも転がっていかないように）
  wall(-55, 28, -55, 33, -1, 0, false),
  wall(55, 28, 55, 33, 1, 0, false),
  wall(-60, 62, -60, 70, -1, 0, false),
  wall(60, 62, 60, 70, 1, 0, false),
  // 大通りの両側
  wall(-60, 62, -3.2, 62, 0, -1),
  wall(3.2, 62, 60, 62, 0, -1),
  wall(-60, 70, -2.2, 70, 0, 1),
  wall(2.2, 70, 60, 70, 0, 1),
  // 路地
  wall(-2.2, 70, -2.2, 104, -1, 0),
  wall(2.2, 70, 2.2, 110, 1, 0),
  // 家の前の道
  wall(-40, 104, -2.2, 104, 0, -1),
  wall(-40, 110, 2.2, 110, 0, 1, false),
  wall(-40, 104, -40, 110, -1, 0),
];

export const GUTTERS: Gutter[] = [
  // 道A 西側：最初はふたつき、空き地の前後はふたなし
  { rect: rect(-3.2, -3.2 + GUTTER_W, -4, 28), lids: [rect(-3.2, -3.2 + GUTTER_W, -4, 14)] },
  { rect: rect(-3.2, -3.2 + GUTTER_W, 33, 44), lids: [] },
  { rect: rect(-3.2, -3.2 + GUTTER_W, 52, 62), lids: [rect(-3.2, -3.2 + GUTTER_W, 57, 62)] },
  // 道A 東側
  { rect: rect(3.2 - GUTTER_W, 3.2, -4, 28), lids: [rect(3.2 - GUTTER_W, 3.2, -4, 8), rect(3.2 - GUTTER_W, 3.2, 18, 21)] },
  { rect: rect(3.2 - GUTTER_W, 3.2, 33, 62), lids: [rect(3.2 - GUTTER_W, 3.2, 40, 43), rect(3.2 - GUTTER_W, 3.2, 57, 62)] },
  // 路地の東側
  { rect: rect(2.2 - GUTTER_W, 2.2, 70, 110), lids: [rect(2.2 - GUTTER_W, 2.2, 70, 73), rect(2.2 - GUTTER_W, 2.2, 85, 90)] },
  // 家の前の道の南側
  { rect: rect(-40, -2.2, 104, 104 + GUTTER_W), lids: [rect(-20, -15, 104, 104 + GUTTER_W)] },
];

export const POLES: PoleCollider[] = [
  { x: 2.6, z: 20, radius: 0.16 },
  { x: -2.6, z: 38, radius: 0.16 },
  { x: -1.95, z: 92, radius: 0.16 },
  { x: -15, z: 109.8, radius: 0.16 },
];

export const CAR_ROADS: CarRoad[] = [
  {
    rect: SIDE_STREET,
    signal: false,
    lanes: [{ z: 30.5, dir: 1, xStart: -55, xEnd: 55, cruise: 6, interval: [7, 13] }],
  },
  {
    rect: MAIN_ROAD,
    signal: true,
    lanes: [
      { z: 64, dir: 1, xStart: -60, xEnd: 60, cruise: 9, interval: [3.5, 8], stopX: -4.6 },
      { z: 68, dir: -1, xStart: 60, xEnd: -60, cruise: 9, interval: [3.5, 8], stopX: 4.6 },
    ],
  },
];

/** 家の門の前のマット。ここで石が止まればクリア */
export const HOME_MAT = rect(-35.2, -32.8, 108.3, 110);
export const HOME_GATE_X = -34;

export const START = { x: -0.6, z: 1.5 };

/** 帰り道の中心線。キックの基準方向と残り距離に使う */
export const ROUTE: ReadonlyArray<readonly [number, number]> = [
  [0, -2],
  [0, 107],
  [HOME_GATE_X, 107],
  [HOME_GATE_X, 109.2],
];

export const inRect = (r: Rect, x: number, z: number, margin = 0) =>
  x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;

export type Hazard = 'gutter' | 'grass';

/** 石の中心位置が回収不能な場所か */
export function hazardAt(x: number, z: number): { kind: Hazard; rect: Rect } | null {
  for (const g of GUTTERS) {
    if (!inRect(g.rect, x, z)) continue;
    if (g.lids.some((l) => inRect(l, x, z))) continue;
    return { kind: 'gutter', rect: g.rect };
  }
  if (inRect(GRASS_LOST, x, z)) return { kind: 'grass', rect: GRASS_LOST };
  return null;
}

export function carRoadAt(x: number, z: number): CarRoad | null {
  return CAR_ROADS.find((r) => inRect(r.rect, x, z)) ?? null;
}

export const isAtHome = (x: number, z: number) => inRect(HOME_MAT, x, z);

// ---------- 帰り道に沿った距離 ----------
const routeLens: number[] = [];
let routeTotal = 0;
for (let i = 0; i < ROUTE.length - 1; i++) {
  const l = Math.hypot(ROUTE[i + 1][0] - ROUTE[i][0], ROUTE[i + 1][1] - ROUTE[i][1]);
  routeLens.push(l);
  routeTotal += l;
}
export const ROUTE_LENGTH = routeTotal;

/** 点を帰り道へ投影したときの、学校からの道のり */
export function routeProgress(x: number, z: number): number {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 0; i < routeLens.length; i++) {
    const [ax, az] = ROUTE[i];
    const [bx, bz] = ROUTE[i + 1];
    const l = routeLens[i];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (l * l)));
    const d = Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z);
    if (d < best) {
      best = d;
      bestS = acc + l * t;
    }
    acc += l;
  }
  return bestS;
}

/** 道のり s の地点の座標 */
export function routePoint(s: number): [number, number] {
  let acc = 0;
  for (let i = 0; i < routeLens.length; i++) {
    const l = routeLens[i];
    if (s <= acc + l || i === routeLens.length - 1) {
      const t = Math.max(0, Math.min(1, (s - acc) / l));
      const [ax, az] = ROUTE[i];
      const [bx, bz] = ROUTE[i + 1];
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }
    acc += l;
  }
  return [ROUTE[ROUTE.length - 1][0], ROUTE[ROUTE.length - 1][1]];
}
