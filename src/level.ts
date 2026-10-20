/**
 * 固定の通学路。描画（world.ts）・物理（stone.ts）・交通（traffic.ts）が共通で参照するデータ。
 *
 *   学校 → 大きな道の西側の歩道（車が行き交う）→ 横道の入口 → 空き地の前
 *   → 大通りとの交差点（信号つき横断歩道）→ 歩道の続き → 左の路地へ → 家
 *
 * 座標は +Z が学校から家へ向かう方向。車は左側通行。
 * 歩道は車道より一段（縁石の高さ）高い。車の来ない横道と路地は車道と同じ高さ。
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

/**
 * 縁石。車道側（法線の向き）から来た石だけが、縁石より低ければ跳ね返る。
 * 歩道側からは段差を落ちるだけ。
 */
export interface Curb {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  nx: number;
  nz: number;
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

export type SignalGroup = 'A' | 'B';

export interface CarLaneDef {
  /** 車が走る軸 */
  axis: 'x' | 'z';
  /** 車線中心の、走る軸と直交する座標 */
  c: number;
  dir: 1 | -1;
  /** 車が現れる位置と消える位置（走る軸上） */
  sStart: number;
  sEnd: number;
  cruise: number;
  /** 出現間隔 [s] の範囲 */
  interval: [number, number];
  /** 信号待ちで車の先頭が止まる位置（走る軸上） */
  stopAt?: number;
  signal?: SignalGroup;
}

export interface CarRoad {
  rect: Rect;
  lanes: CarLaneDef[];
  /** 子どもが渡ってよい条件：歩行者信号か、車が来ていないか */
  crossing: 'signal' | 'gap';
}

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 });
const wall = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number, houses = true): WallSeg => ({ x1, z1, x2, z2, nx, nz, houses });
const curb = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number): Curb => ({ x1, z1, x2, z2, nx, nz });

export const CURB_HEIGHT = 0.12;
export const GUTTER_W = 0.45;

// ---------- 主な寸法 ----------
/** 西側の歩道（通学路）の x 範囲 */
const SW_X0 = -3;
const SW_X1 = -0.5;
/** 大きな道（道A）の車道 */
const RA_X0 = SW_X1;
const RA_X1 = 6.1;
/** 東側の歩道 */
const SE_X1 = 8.1;
/** 大通り（道B）の車道と歩道 */
const RB_Z0 = 60;
const RB_Z1 = 68;
const SB_S = 57.5;
const SB_N = 70.5;
/** 車の来ない横道と路地 */
const SIDE_Z0 = 28;
const SIDE_Z1 = 32;
const ALLEY_Z0 = 108;
const ALLEY_Z1 = 112;
const ALLEY_X0 = -40;
/** 家の門（路地の北側）と、門から玄関までのアプローチ */
export const HOME_GATE_X = -30;
const GATE_HALF = 1.2;
const PORCH_Z1 = ALLEY_Z1 + 2.2;

/** 道Aの車道 */
export const ROAD_A = rect(RA_X0, RA_X1, -40, 200);
/** 大通りの車道 */
export const MAIN_ROAD = rect(-60, 60, RB_Z0, RB_Z1);
/** 車の来ない横道（入口は車道と同じ高さ） */
export const SIDE_STREET = rect(-45, SW_X1, SIDE_Z0, SIDE_Z1);
/** 家へ続く路地 */
export const ALLEY = rect(ALLEY_X0, SW_X1, ALLEY_Z0, ALLEY_Z1);
/** 大通りの横断歩道 */
export const CROSSWALK = rect(SW_X0, SW_X1, RB_Z0, RB_Z1);

/** 歩道（縁石の高さだけ高い） */
export const SIDEWALKS: Rect[] = [
  // 西側（通学路）。横道と路地の入口で途切れる
  rect(SW_X0, SW_X1, -3, SIDE_Z0),
  rect(SW_X0, SW_X1, SIDE_Z1, RB_Z0),
  rect(SW_X0, SW_X1, RB_Z1, ALLEY_Z0),
  rect(SW_X0, SW_X1, ALLEY_Z1, 200),
  // 東側
  rect(RA_X1, SE_X1, -40, RB_Z0),
  rect(RA_X1, SE_X1, RB_Z1, 200),
  // 大通りの両側
  rect(-60, SW_X0, SB_S, RB_Z0),
  rect(SE_X1, 60, SB_S, RB_Z0),
  rect(-60, SW_X0, RB_Z1, SB_N),
  rect(SE_X1, 60, RB_Z1, SB_N),
];

/** 車道と同じ高さの舗装（描画用） */
export const ROADWAYS: Rect[] = [ROAD_A, MAIN_ROAD, SIDE_STREET, ALLEY];
/** 家などを置いてはいけない範囲 */
export const PAVED: Rect[] = [...ROADWAYS, ...SIDEWALKS];

/** 縁石の切り下げ（車庫の出入口、横道・路地の入口）。ここは段差がなく石が上り下りできる */
export const RAMPS: Rect[] = [
  rect(SW_X0, SW_X1, SIDE_Z0 - 0.6, SIDE_Z0),
  rect(SW_X0, SW_X1, SIDE_Z1, SIDE_Z1 + 0.6),
  rect(SW_X0, SW_X1, ALLEY_Z0 - 0.6, ALLEY_Z0),
  rect(SW_X0, SW_X1, ALLEY_Z1, ALLEY_Z1 + 0.6),
  rect(SW_X1 - 0.6, SW_X1, 14, 16.5),
  rect(SW_X1 - 0.6, SW_X1, 46, 48.5),
  rect(SW_X1 - 0.6, SW_X1, 82, 84.5),
  rect(SW_X1 - 0.6, SW_X1, 96, 98.5),
];

/** 塀のない空き地。草むらに入った石は見つからない */
export const GRASS_LOT = rect(-12, SW_X0, 38, 46);
/** 石の中心がここまで入ったら見失う */
export const GRASS_LOST = rect(-12, SW_X0 - 0.2, 38, 46);

export const WALLS: WallSeg[] = [
  // 学校の門の脇（歩道の南端）
  wall(SW_X0, -3, SW_X1, -3, 0, -1, false),
  // 西側の塀（学校・横道・空き地・路地で途切れる）
  wall(SW_X0, -3, SW_X0, 6, -1, 0, false),
  wall(SW_X0, 6, SW_X0, SIDE_Z0, -1, 0),
  wall(SW_X0, SIDE_Z1, SW_X0, GRASS_LOT.z0, -1, 0),
  wall(SW_X0, GRASS_LOT.z1, SW_X0, SB_S, -1, 0),
  wall(SW_X0, SB_N, SW_X0, ALLEY_Z0, -1, 0),
  wall(SW_X0, ALLEY_Z1, SW_X0, 200, -1, 0),
  // 横道
  wall(-45, SIDE_Z0, SW_X0, SIDE_Z0, 0, -1),
  wall(-45, SIDE_Z1, SW_X0, SIDE_Z1, 0, 1),
  wall(-45, SIDE_Z0, -45, SIDE_Z1, -1, 0, false),
  // 大通りの歩道の外側
  wall(-60, SB_S, SW_X0, SB_S, 0, -1),
  wall(SE_X1, SB_S, 60, SB_S, 0, -1),
  wall(-60, SB_N, SW_X0, SB_N, 0, 1),
  wall(SE_X1, SB_N, 60, SB_N, 0, 1),
  // 東側の塀
  wall(SE_X1, -40, SE_X1, SB_S, 1, 0),
  wall(SE_X1, SB_N, SE_X1, 200, 1, 0),
  // 道の両端は町はずれ（石がどこまでも行かないように）
  wall(-60, SB_S, -60, SB_N, -1, 0, false),
  wall(60, SB_S, 60, SB_N, 1, 0, false),
  wall(SW_X0, -40, SE_X1, -40, 0, -1, false),
  wall(SW_X0, 200, SE_X1, 200, 0, 1, false),
  // 学校の敷地と車道の境（歩道が始まる手前）
  wall(SW_X1, -40, SW_X1, -3, -1, 0, false),
  // 路地
  wall(ALLEY_X0, ALLEY_Z0, SW_X0, ALLEY_Z0, 0, -1),
  // 路地の北側は家の門のところだけ開いている
  wall(ALLEY_X0, ALLEY_Z1, HOME_GATE_X - GATE_HALF, ALLEY_Z1, 0, 1, false),
  wall(HOME_GATE_X + GATE_HALF, ALLEY_Z1, SW_X0, ALLEY_Z1, 0, 1, false),
  // 門から玄関までの両脇の生け垣と、玄関
  wall(HOME_GATE_X - GATE_HALF, ALLEY_Z1, HOME_GATE_X - GATE_HALF, PORCH_Z1, -1, 0, false),
  wall(HOME_GATE_X + GATE_HALF, ALLEY_Z1, HOME_GATE_X + GATE_HALF, PORCH_Z1, 1, 0, false),
  wall(HOME_GATE_X - GATE_HALF, PORCH_Z1, HOME_GATE_X + GATE_HALF, PORCH_Z1, 0, 1, false),
  wall(ALLEY_X0, ALLEY_Z0, ALLEY_X0, ALLEY_Z1, -1, 0),
];

/** 縁石。切り下げ・横断歩道・横道や路地の入口で途切れる（入口は段差なし） */
export const CURBS: Curb[] = (() => {
  const list: Curb[] = [];
  // 西側の歩道の車道側（x = SW_X1）。切り下げで分割
  const westSpans: [number, number][] = [[-3, SIDE_Z0], [SIDE_Z1, RB_Z0], [RB_Z1, ALLEY_Z0], [ALLEY_Z1, 200]];
  for (const [z0, z1] of westSpans) {
    let z = z0;
    for (const r of [...RAMPS].sort((a, b) => a.z0 - b.z0)) {
      if (r.x1 === SW_X1 && r.z0 >= z && r.z1 <= z1) {
        list.push(curb(SW_X1, z, SW_X1, r.z0, 1, 0));
        z = r.z1;
      }
    }
    list.push(curb(SW_X1, z, SW_X1, z1, 1, 0));
  }
  // 東側の歩道
  list.push(curb(RA_X1, -40, RA_X1, RB_Z0, -1, 0), curb(RA_X1, RB_Z1, RA_X1, 200, -1, 0));
  // 大通りの歩道（横断歩道の部分は切り下げ）
  list.push(curb(-60, RB_Z0, SW_X0, RB_Z0, 0, 1), curb(RA_X1, RB_Z0, 60, RB_Z0, 0, 1));
  list.push(curb(-60, RB_Z1, SW_X0, RB_Z1, 0, -1), curb(RA_X1, RB_Z1, 60, RB_Z1, 0, -1));
  return list;
})();

/** 車道の路肩の集水ます（格子のふた）。石がはまると取れない */
export const GRATES: Rect[] = [10, 22, 36, 52, 76, 90, 103].map((z) => rect(SW_X1, SW_X1 + 0.45, z, z + 0.7));

export const GUTTERS: Gutter[] = [
  // 横道の両側
  { rect: rect(-45, SW_X0, SIDE_Z0, SIDE_Z0 + GUTTER_W), lids: [rect(-12, SW_X0, SIDE_Z0, SIDE_Z0 + GUTTER_W)] },
  { rect: rect(-45, SW_X0, SIDE_Z1 - GUTTER_W, SIDE_Z1), lids: [rect(-8, SW_X0, SIDE_Z1 - GUTTER_W, SIDE_Z1)] },
  // 路地の南側
  { rect: rect(ALLEY_X0, SW_X0, ALLEY_Z0, ALLEY_Z0 + GUTTER_W), lids: [rect(-9, SW_X0, ALLEY_Z0, ALLEY_Z0 + GUTTER_W), rect(-22, -17, ALLEY_Z0, ALLEY_Z0 + GUTTER_W)] },
];

export const POLES: PoleCollider[] = [
  { x: SW_X1 - 0.35, z: 19, radius: 0.16 },
  { x: SW_X1 - 0.35, z: 42, radius: 0.16 },
  { x: SW_X1 - 0.35, z: 79, radius: 0.16 },
  { x: SW_X1 - 0.35, z: 101, radius: 0.16 },
  { x: -20, z: ALLEY_Z1 - 0.2, radius: 0.16 },
];

export const CAR_ROADS: CarRoad[] = [
  {
    rect: MAIN_ROAD,
    crossing: 'signal',
    lanes: [
      // 左側通行：東行きは南側の車線
      { axis: 'x', c: 62, dir: 1, sStart: -60, sEnd: 60, cruise: 9, interval: [4, 9], stopAt: SW_X0 - 0.6, signal: 'B' },
      { axis: 'x', c: 66, dir: -1, sStart: 60, sEnd: -60, cruise: 9, interval: [4, 9], stopAt: RA_X1 + 0.6, signal: 'B' },
    ],
  },
  {
    rect: ROAD_A,
    crossing: 'gap',
    lanes: [
      // 歩道側の車線は向こうから来る（南行き）ので早めに見える
      { axis: 'z', c: 1.3, dir: -1, sStart: 200, sEnd: -40, cruise: 8, interval: [5, 11], stopAt: RB_Z1 + 0.6, signal: 'A' },
      { axis: 'z', c: 4.3, dir: 1, sStart: -40, sEnd: 200, cruise: 8, interval: [5, 11], stopAt: RB_Z0 - 0.6, signal: 'A' },
    ],
  },
];

/** 門の前から玄関まで。ここで石が止まればクリア */
export const HOME_MAT = rect(HOME_GATE_X - GATE_HALF, HOME_GATE_X + GATE_HALF, ALLEY_Z1 - 0.8, PORCH_Z1);
/** 門から玄関までのアプローチ（描画用） */
export const HOME_PORCH = rect(HOME_GATE_X - GATE_HALF, HOME_GATE_X + GATE_HALF, ALLEY_Z1, PORCH_Z1);
export const HOME_ROAD = ALLEY;

export const START = { x: -1.6, z: 1.0 };

/** 帰り道の中心線。キックの基準方向と残り距離に使う */
const SW_MID = (SW_X0 + SW_X1) / 2;
const ALLEY_MID = (ALLEY_Z0 + ALLEY_Z1) / 2;
export const ROUTE: ReadonlyArray<readonly [number, number]> = [
  [SW_MID, -2],
  [SW_MID, ALLEY_MID],
  [HOME_GATE_X, ALLEY_MID],
  [HOME_GATE_X, PORCH_Z1 - 0.8],
];

export const inRect = (r: Rect, x: number, z: number, margin = 0) =>
  x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;

/** 地面の高さ（歩道の上は縁石の高さ） */
export function groundAt(x: number, z: number): number {
  return SIDEWALKS.some((r) => inRect(r, x, z)) ? CURB_HEIGHT : 0;
}

export const sidewalkAt = (x: number, z: number) => SIDEWALKS.find((r) => inRect(r, x, z)) ?? null;

export type Hazard = 'gutter' | 'grass' | 'grate';

/** 石の中心位置が回収不能な場所か */
export function hazardAt(x: number, z: number): { kind: Hazard; rect: Rect } | null {
  for (const g of GRATES) if (inRect(g, x, z)) return { kind: 'grate', rect: g };
  for (const g of GUTTERS) {
    if (!inRect(g.rect, x, z)) continue;
    if (g.lids.some((l) => inRect(l, x, z))) continue;
    return { kind: 'gutter', rect: g.rect };
  }
  if (inRect(GRASS_LOST, x, z)) return { kind: 'grass', rect: GRASS_LOST };
  return null;
}

/** 車道の上か（大通りを先に見るので、交差点の中は大通り扱い） */
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
