/**
 * 通学路の自動生成。描画（world.ts）・物理（stone.ts）・交通（traffic.ts）が共通で参照するデータ。
 *
 *   学校 → 車が行き交う道（道A）の西側の歩道を北へ
 *        （住宅街・商店街・田んぼ・公園・空き地・横道の入口・信号つき交差点を組み合わせる）
 *   → 西の路地へ曲がる（途中で北へ折れることもある）→ 家
 *
 * 座標は +Z が学校から家へ向かう方向。車は左側通行。
 * 歩道は車道より一段（縁石の高さ）高い。車の来ない横道と路地は車道と同じ高さ。
 *
 * 必ず攻略できるように、通れる幅（歩道 2.5 m、路地 3.4 m 以上）は常に残し、
 * 側溝は路地の片側だけ、障害物は歩道の外側の端だけに置く。
 */
import { createRng } from './rng';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type WallStyle = 'block' | 'fence' | 'shop' | 'hedge' | 'plain';

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
  style: WallStyle;
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

export interface CarStop {
  /** 車の先頭が止まる位置（走る軸上） */
  at: number;
  /** どの交差点の信号に従うか */
  signal: number;
  group: SignalGroup;
}

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
  stops: CarStop[];
}

export interface CarRoad {
  rect: Rect;
  lanes: CarLaneDef[];
  /** 子どもが渡ってよい条件：歩行者信号か、車が来ていないか */
  crossing: 'signal' | 'gap';
  /** crossing が signal のとき、どの交差点の信号か */
  signal?: number;
}

/** 大通りとの交差点。歩道の z 範囲（南の歩道の端から北の歩道の端まで） */
export interface Intersection {
  z0: number;
  z1: number;
  /** 車道の z 範囲 */
  rz0: number;
  rz1: number;
  /** 信号の位相のずれ [s] */
  phase: number;
}

export type Hazard = 'gutter' | 'grass' | 'grate' | 'water';

export interface LostZone {
  kind: 'grass' | 'water';
  rect: Rect;
}

/** 見た目だけの区画（world.ts が描き分ける） */
export interface Decor {
  kind: 'school' | 'shops' | 'paddy' | 'park' | 'lot';
  rect: Rect;
  /** 道に面している辺の向き（外向き法線の逆、つまり道の方向） */
  face: 'east' | 'south' | 'north' | 'west';
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Home {
  gateX: number;
  /** 門のある塀の z（路地の北側） */
  wallZ: number;
  porch: Rect;
  /** ここで石が止まればクリア */
  mat: Rect;
  /** 家の色の種（主人公ごとに外観を変える） */
  seed: number;
}

export const CURB_HEIGHT = 0.12;
export const GUTTER_W = 0.45;

// ---------- 道Aまわりの固定寸法 ----------
/** 西側の歩道（通学路）の x 範囲 */
export const SW_X0 = -3;
export const SW_X1 = -0.5;
const SW_MID = (SW_X0 + SW_X1) / 2;
/** 道Aの車道と東側の歩道 */
export const RA_X1 = 6.1;
export const SE_X1 = 8.1;
/** 大通り・横道が東西に伸びる長さ */
const CROSS_X = 70;
const ROAD_A_Z0 = -40;
const SCHOOL_Z1 = 6;

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  x1: Math.max(x0, x1),
  z0: Math.min(z0, z1),
  z1: Math.max(z0, z1),
});
const wall = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number, houses = true, style: WallStyle = 'block'): WallSeg =>
  ({ x1, z1, x2, z2, nx, nz, houses, style });
const curb = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number): Curb => ({ x1, z1, x2, z2, nx, nz });

export const inRect = (r: Rect, x: number, z: number, margin = 0) =>
  x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;

/** 区間 [a, b] から、いくつかの区間を取り除いた残り */
function subtractSpans(a: number, b: number, holes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cur = a;
  for (const [h0, h1] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (h1 <= cur || h0 >= b) continue;
    if (h0 > cur) out.push([cur, Math.min(h0, b)]);
    cur = Math.max(cur, h1);
  }
  if (cur < b) out.push([cur, b]);
  return out.filter(([p, q]) => q - p > 0.05);
}

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'やさしい', normal: 'ふつう', hard: 'むずかしい' };

/** 道Aぞいの区間の種類 */
type SegmentKind = 'houses' | 'shops' | 'paddy' | 'park' | 'lot' | 'side' | 'signal';

export class Level {
  readonly difficulty: Difficulty;
  readonly roadways: Rect[] = [];
  readonly sidewalks: Rect[] = [];
  readonly walls: WallSeg[] = [];
  readonly curbs: Curb[] = [];
  readonly ramps: Rect[] = [];
  readonly grates: Rect[] = [];
  readonly gutters: Gutter[] = [];
  readonly lostZones: LostZone[] = [];
  readonly poles: PoleCollider[] = [];
  /** 自転車や看板など、石が跳ね返る低い箱 */
  readonly blocks: Rect[] = [];
  readonly carRoads: CarRoad[] = [];
  readonly intersections: Intersection[] = [];
  readonly decor: Decor[] = [];
  /** 家を置いてはいけない範囲 */
  readonly reserved: Rect[] = [];
  readonly lanes: Rect[] = [];
  readonly route: [number, number][] = [];
  readonly start = { x: SW_MID + 0.15, z: 1.0 };
  home!: Home;
  roadA!: Rect;
  /** 路地の幅 */
  readonly laneWidth: number;
  /** 区間の並び（デバッグ・表示用） */
  readonly segments: { kind: SegmentKind; z0: number; z1: number }[] = [];

  private readonly routeLens: number[] = [];
  routeLength = 0;

  constructor(readonly seed: number) {
    const rand = createRng(seed);
    const r = rand();
    this.difficulty = r < 0.3 ? 'easy' : r < 0.75 ? 'normal' : 'hard';
    this.laneWidth = this.difficulty === 'hard' && rand() < 0.6 ? 3.4 : 4.4;
    this.generate(rand);
    for (let i = 0; i < this.route.length - 1; i++) {
      const l = Math.hypot(this.route[i + 1][0] - this.route[i][0], this.route[i + 1][1] - this.route[i][1]);
      this.routeLens.push(l);
      this.routeLength += l;
    }
  }

  get difficultyLabel() {
    return DIFFICULTY_LABEL[this.difficulty];
  }

  // ---------- 生成 ----------

  private generate(rand: () => number) {
    const d = this.difficulty;
    const turnTarget = { easy: 70, normal: 92, hard: 112 }[d] + rand() * 20;

    // 1) 道Aぞいの区間を並べる
    let z = SCHOOL_Z1;
    let prev: SegmentKind = 'houses';
    let signals = 0;
    const maxSignals = d === 'easy' ? 1 : 2;
    while (z < turnTarget) {
      const kind = this.pickSegment(rand, z, prev, signals < maxSignals);
      const len = this.segmentLength(kind, rand);
      this.segments.push({ kind, z0: z, z1: z + len });
      if (kind === 'signal') signals++;
      prev = kind;
      z += len;
    }
    const turnZ = z;
    const w = this.laneWidth;
    const zEnd = turnZ + w + 70;
    this.roadA = rect(SW_X1, RA_X1, ROAD_A_Z0, zEnd);

    // 2) 道Aの車道・歩道・塀・縁石
    this.buildRoadA(rand, turnZ, zEnd);
    // 3) 区間ごとの西側
    for (const s of this.segments) this.buildSegment(rand, s.kind, s.z0, s.z1);
    // 学校
    this.walls.push(wall(SW_X0, -3, SW_X1, -3, 0, -1, false, 'plain'));
    this.walls.push(wall(SW_X0, -3, SW_X0, SCHOOL_Z1, -1, 0, false, 'fence'));
    this.walls.push(wall(SW_X1, ROAD_A_Z0, SW_X1, -3, -1, 0, false, 'plain'));
    this.decor.push({ kind: 'school', rect: rect(-18, SW_X0, -16, SCHOOL_Z1), face: 'east' });
    this.reserved.push(rect(-18, SW_X0, -16, SCHOOL_Z1));
    // 路地の北側（道Aぞいの続き）
    this.walls.push(wall(SW_X0, turnZ + w, SW_X0, zEnd, -1, 0));

    // 4) 路地
    this.buildLanes(rand, turnZ);

    // 5) 交通
    this.buildTraffic(zEnd);
  }

  private pickSegment(rand: () => number, z: number, prev: SegmentKind, signalOk: boolean): SegmentKind {
    const d = this.difficulty;
    // 学校を出てすぐは穏やかに。家に近づくほど難しい区間が出やすい
    if (z < SCHOOL_Z1 + 10) return 'houses';
    const late = z > 50 ? 1 : 0;
    const weights: [SegmentKind, number][] = [
      ['houses', 3],
      ['shops', 1.5],
      ['paddy', d === 'easy' ? 0.6 : 1.2 + late],
      ['park', 1],
      ['lot', d === 'easy' ? 0.5 : 1 + late * 0.5],
      ['side', 1],
      ['signal', signalOk && z > 30 ? (d === 'hard' ? 1.6 : 1.1) : 0],
    ];
    const allowed = weights.filter(([k]) => k !== prev || k === 'houses');
    const total = allowed.reduce((a, [, w]) => a + w, 0);
    let x = rand() * total;
    for (const [k, w] of allowed) {
      x -= w;
      if (x <= 0) return k;
    }
    return 'houses';
  }

  private segmentLength(kind: SegmentKind, rand: () => number): number {
    switch (kind) {
      case 'houses': return 12 + Math.round(rand() * 12);
      case 'shops': return 16 + Math.round(rand() * 8);
      case 'paddy': return 14 + Math.round(rand() * 12);
      case 'park': return 16 + Math.round(rand() * 8);
      case 'lot': return 8;
      case 'side': return 4 + 3;
      case 'signal': return 13;
    }
  }

  /** 道Aの車道と、東西の歩道・縁石・東側の塀 */
  private buildRoadA(rand: () => number, turnZ: number, zEnd: number) {
    const w = this.laneWidth;
    this.roadways.push(this.roadA);
    // 歩道が途切れるところ：横道・路地の入口（車道と同じ高さ）、交差点の車道
    const westGaps: [number, number][] = [[turnZ, turnZ + w]];
    const crossGaps: [number, number][] = [];
    for (const s of this.segments) {
      if (s.kind === 'side') westGaps.push([s.z0 + 1.5, s.z0 + 5.5]);
      if (s.kind === 'signal') crossGaps.push([s.z0 + 2.5, s.z0 + 10.5]);
    }
    for (const [a, b] of subtractSpans(-3, zEnd, [...westGaps, ...crossGaps])) this.sidewalks.push(rect(SW_X0, SW_X1, a, b));
    for (const [a, b] of subtractSpans(ROAD_A_Z0, zEnd, crossGaps)) this.sidewalks.push(rect(RA_X1, SE_X1, a, b));

    // 切り下げ（車庫の出入口）と、横道・路地の入口の脇
    const d = this.difficulty;
    for (const s of this.segments) {
      if (s.kind === 'houses' && s.z1 - s.z0 >= 14 && rand() < 0.8) {
        const zr = s.z0 + 3 + rand() * (s.z1 - s.z0 - 8);
        this.ramps.push(rect(SW_X1 - 0.6, SW_X1, zr, zr + 2.5));
      }
    }
    for (const [a, b] of westGaps) {
      this.ramps.push(rect(SW_X0, SW_X1, a - 0.6, a), rect(SW_X0, SW_X1, b, b + 0.6));
    }

    // 縁石（切り下げ・入口・交差点で途切れる）
    const rampSpans = this.ramps.filter((r) => r.x1 === SW_X1).map((r) => [r.z0, r.z1] as [number, number]);
    for (const [a, b] of subtractSpans(-3, zEnd, [...westGaps, ...crossGaps, ...rampSpans])) this.curbs.push(curb(SW_X1, a, SW_X1, b, 1, 0));
    for (const [a, b] of subtractSpans(ROAD_A_Z0, zEnd, crossGaps)) this.curbs.push(curb(RA_X1, a, RA_X1, b, -1, 0));

    // 東側の塀と道の両端
    for (const [a, b] of subtractSpans(ROAD_A_Z0, zEnd, this.segments.filter((s) => s.kind === 'signal').map((s) => [s.z0, s.z1]))) {
      this.walls.push(wall(SE_X1, a, SE_X1, b, 1, 0));
    }
    this.walls.push(wall(SW_X1, ROAD_A_Z0, SE_X1, ROAD_A_Z0, 0, -1, false, 'plain'));
    this.walls.push(wall(SW_X0, zEnd, SE_X1, zEnd, 0, 1, false, 'plain'));

    // 集水ます：路肩に一定の間隔で。切り下げや入口とは重ならないように
    const spacing = { easy: 24, normal: 15, hard: 10 }[d];
    for (let zg = 8 + rand() * 6; zg < turnZ - 2; zg += spacing * (0.7 + rand() * 0.6)) {
      const g = rect(SW_X1, SW_X1 + 0.45, zg, zg + 0.7);
      const blocked = [...westGaps, ...crossGaps, ...rampSpans].some(([a, b]) => zg + 0.7 > a - 1 && zg < b + 1);
      if (!blocked) this.grates.push(g);
    }
  }

  private buildSegment(rand: () => number, kind: SegmentKind, z0: number, z1: number) {
    const westWall = (a: number, b: number, houses = true, style: WallStyle = 'block') => this.walls.push(wall(SW_X0, a, SW_X0, b, -1, 0, houses, style));
    const d = this.difficulty;
    switch (kind) {
      case 'houses': {
        westWall(z0, z1);
        if (rand() < 0.6) this.poles.push({ x: SW_X1 - 0.35, z: z0 + 2 + rand() * (z1 - z0 - 4), radius: 0.16 });
        break;
      }
      case 'shops': {
        // 店先の壁。自転車や立て看板が歩道の外側の端に並ぶ
        westWall(z0, z1, false, 'shop');
        this.decor.push({ kind: 'shops', rect: rect(-10, SW_X0, z0, z1), face: 'east' });
        this.reserved.push(rect(-10, SW_X0, z0, z1));
        const n = d === 'easy' ? 1 : d === 'normal' ? 2 : 3;
        for (let i = 0; i < n; i++) {
          const zb = z0 + 2 + ((i + rand() * 0.6) / n) * (z1 - z0 - 5);
          if (rand() < 0.65) this.blocks.push(rect(SW_X0, SW_X0 + 0.55, zb, zb + 1.7)); // 自転車
          else this.blocks.push(rect(SW_X0 + 0.1, SW_X0 + 0.55, zb, zb + 0.5)); // 立て看板
        }
        break;
      }
      case 'paddy': {
        // 塀はなく、歩道の外は田んぼ。落ちたら拾えない
        this.decor.push({ kind: 'paddy', rect: rect(-40, SW_X0, z0, z1), face: 'east' });
        this.reserved.push(rect(-40, SW_X0, z0, z1));
        this.lostZones.push({ kind: 'water', rect: rect(-40, SW_X0 - 0.15, z0, z1) });
        break;
      }
      case 'park': {
        // 低い柵と入口。入口から公園の植え込みに入ると見つからない
        const zg = z0 + 4 + rand() * (z1 - z0 - 10);
        westWall(z0, zg, false, 'fence');
        westWall(zg + 2.2, z1, false, 'fence');
        this.decor.push({ kind: 'park', rect: rect(-30, SW_X0, z0, z1), face: 'east' });
        this.reserved.push(rect(-30, SW_X0, z0, z1));
        this.lostZones.push({ kind: 'grass', rect: rect(-30, SW_X0 - 0.6, z0, z1) });
        break;
      }
      case 'lot': {
        this.decor.push({ kind: 'lot', rect: rect(-12, SW_X0, z0, z1), face: 'east' });
        this.reserved.push(rect(-12, SW_X0, z0, z1));
        this.lostZones.push({ kind: 'grass', rect: rect(-12, SW_X0 - 0.2, z0, z1) });
        break;
      }
      case 'side': {
        // 車の来ない横道。入口は車道と同じ高さで、両側に側溝
        const a = z0 + 1.5;
        const b = z0 + 5.5;
        westWall(z0, a);
        westWall(b, z1);
        const side = rect(-40, SW_X1, a, b);
        this.roadways.push(side);
        this.lanes.push(side);
        this.walls.push(wall(-40, a, SW_X0, a, 0, -1), wall(-40, b, SW_X0, b, 0, 1), wall(-40, a, -40, b, -1, 0));
        const lid = (x0: number) => rect(x0, SW_X0, 0, 0);
        for (const [g0, g1] of [[a, a + GUTTER_W], [b - GUTTER_W, b]]) {
          const l = lid(-6 - rand() * 8);
          this.gutters.push({ rect: rect(-40, SW_X0, g0, g1), lids: [{ ...l, z0: g0, z1: g1 }] });
        }
        break;
      }
      case 'signal': {
        // 大通りとの交差点：南の歩道、車道（2車線）、北の歩道
        const rz0 = z0 + 2.5;
        const rz1 = z0 + 10.5;
        const index = this.intersections.length;
        this.intersections.push({ z0, z1, rz0, rz1, phase: rand() * 30 });
        const road = rect(-CROSS_X, CROSS_X, rz0, rz1);
        this.roadways.push(road);
        this.sidewalks.push(rect(-CROSS_X, SW_X0, z0, rz0), rect(SE_X1, CROSS_X, z0, rz0));
        this.sidewalks.push(rect(-CROSS_X, SW_X0, rz1, z1), rect(SE_X1, CROSS_X, rz1, z1));
        this.walls.push(wall(-CROSS_X, z0, SW_X0, z0, 0, -1), wall(SE_X1, z0, CROSS_X, z0, 0, -1));
        this.walls.push(wall(-CROSS_X, z1, SW_X0, z1, 0, 1), wall(SE_X1, z1, CROSS_X, z1, 0, 1));
        this.walls.push(wall(-CROSS_X, z0, -CROSS_X, z1, -1, 0, false, 'plain'), wall(CROSS_X, z0, CROSS_X, z1, 1, 0, false, 'plain'));
        this.curbs.push(curb(-CROSS_X, rz0, SW_X0, rz0, 0, 1), curb(RA_X1, rz0, CROSS_X, rz0, 0, 1));
        this.curbs.push(curb(-CROSS_X, rz1, SW_X0, rz1, 0, -1), curb(RA_X1, rz1, CROSS_X, rz1, 0, -1));
        const interval: [number, number] = { easy: [6, 11], normal: [4, 9], hard: [3, 7] }[d] as [number, number];
        this.carRoads.push({
          rect: road,
          crossing: 'signal',
          signal: index,
          lanes: [
            // 左側通行：東行きは南側の車線
            { axis: 'x', c: rz0 + 2, dir: 1, sStart: -CROSS_X, sEnd: CROSS_X, cruise: 9, interval, stops: [{ at: SW_X0 - 0.6, signal: index, group: 'B' }] },
            { axis: 'x', c: rz1 - 2, dir: -1, sStart: CROSS_X, sEnd: -CROSS_X, cruise: 9, interval, stops: [{ at: RA_X1 + 0.6, signal: index, group: 'B' }] },
          ],
        });
        break;
      }
    }
  }

  /** 道Aから西へ入る路地。途中で北へ折れることもある。最後の区間の北側に家 */
  private buildLanes(rand: () => number, turnZ: number) {
    const w = this.laneWidth;
    const h = w / 2;
    const d = this.difficulty;
    const cz = turnZ + h;
    const legs = d === 'easy' || rand() < 0.4 ? 1 : 3;
    // 路地の中心線（道Aの歩道の外側の端から）
    const pts: [number, number][] = [[SW_X0, cz]];
    if (legs === 1) {
      pts.push([SW_X0 - (22 + rand() * 14), cz]);
    } else {
      const x1 = SW_X0 - (12 + rand() * 12);
      const z2 = cz + 10 + rand() * 8;
      pts.push([x1, cz], [x1, z2], [x1 - (14 + rand() * 10), z2]);
    }

    // 塀：中心線を左右にずらした折れ線（直角の角は外側を伸ばし内側を縮める）
    const sideA = offsetPolyline(pts, h);
    const sideB = offsetPolyline(pts, -h);
    const last = pts.length - 1;
    // 突き当たりの塀の両端（門や田んぼで塀を切る前に控えておく）
    const capA = sideA[sideA.length - 1];
    const capB = sideB[sideB.length - 1];

    // 家：最後の区間（西向き）の北側、突き当たりの少し手前
    const [ex, ez] = pts[last];
    const gateX = ex + 3.6;
    const wallZ = ez + h;
    const porch = rect(gateX - 1.2, gateX + 1.2, wallZ, wallZ + 2.2);
    this.home = { gateX, wallZ, porch, mat: rect(porch.x0, porch.x1, wallZ - 0.8, porch.z1), seed: (rand() * 2 ** 31) | 0 };
    this.reserved.push(rect(gateX - 4, gateX + 4, wallZ, wallZ + 9));

    // 区間ごとの路面と側溝、田んぼぞいの区間（家のある最後の区間は田んぼにしない）
    const paddyLeg = d !== 'easy' && last > 1 && rand() < 0.5 ? Math.floor(rand() * (last - 1)) : -1;
    const paddySide = rand() < 0.5 ? 1 : -1;
    for (let i = 0; i < last; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const along = az === bz ? 'x' : 'z';
      const a = along === 'x' ? ax : az;
      const b = along === 'x' ? bx : bz;
      const dir = Math.sign(b - a);
      // 角では隣の区間と路面を重ねる
      const ext0 = i > 0 ? h : 0;
      const ext1 = i < last - 1 ? h : 0;
      const lane = along === 'x' ? rect(a - dir * ext0, b + dir * ext1, az - h, az + h) : rect(ax - h, ax + h, a - dir * ext0, b + dir * ext1);
      // 最初の区間は道Aの車道の縁まで（入口は車道と同じ高さ）
      if (i === 0) lane.x1 = SW_X1;
      this.roadways.push(lane);
      this.lanes.push(lane);
      this.reserved.push(lane);

      // 区間の両端の角や入口を除いた範囲 [s0, s1]
      const trimStart = i === 0 ? 2 : h + 0.5;
      const trimEnd = i === last - 1 ? 0.5 : h + 0.5;
      const s0 = Math.min(a, b) + (dir > 0 ? trimStart : trimEnd);
      const s1 = Math.max(a, b) - (dir > 0 ? trimEnd : trimStart);
      if (s1 - s0 < 4) continue;
      const lineAt = (n: [number, number]) => (along === 'x' ? az + n[1] * h : ax + n[0] * h);
      const strip = (from: number, to: number) => (along === 'x' ? rect(s0, s1, from, to) : rect(from, to, s0, s1));

      if (i === paddyLeg) {
        // 片側が田んぼ：塀を開けて、外を見失う場所にする
        const n = legNormal(pts, i, paddySide);
        const k = along === 'x' ? n[1] : n[0];
        const edge = lineAt(n);
        this.lostZones.push({ kind: 'water', rect: strip(edge + k * 0.15, edge + k * 25) });
        const field = strip(edge, edge + k * 25);
        this.decor.push({ kind: 'paddy', rect: field, face: along === 'x' ? (k > 0 ? 'south' : 'north') : k > 0 ? 'west' : 'east' });
        this.reserved.push(field);
        cutWalls(paddySide > 0 ? sideA : sideB, strip(edge - 0.01, edge + 0.01));
        continue;
      }
      // 側溝は片側だけ。ふたのかかる割合は難しさで変わる。家の門の前には必ずふた
      const side = rand() < 0.5 ? 1 : -1;
      const n = legNormal(pts, i, side);
      const k = along === 'x' ? n[1] : n[0];
      const edge = lineAt(n);
      const g = strip(edge, edge - k * GUTTER_W);
      const lidRatio = { easy: 0.65, normal: 0.45, hard: 0.25 }[d];
      const lids: Rect[] = [];
      for (let t = s0; t < s1; ) {
        const len = 1.5 + rand() * 4;
        if (rand() < lidRatio) lids.push(along === 'x' ? { ...g, x0: t, x1: Math.min(s1, t + len) } : { ...g, z0: t, z1: Math.min(s1, t + len) });
        t += len + 0.5;
      }
      if (i === last - 1) lids.push({ ...g, x0: porch.x0 - 0.4, x1: porch.x1 + 0.4 });
      this.gutters.push({ rect: g, lids });
      // 電柱は側溝の反対側
      if (rand() < 0.7) {
        const t = s0 + rand() * (s1 - s0);
        const off = h - 0.3;
        this.poles.push(along === 'x' ? { x: t, z: az - n[1] * off, radius: 0.16 } : { x: ax - n[0] * off, z: t, radius: 0.16 });
      }
    }

    // 門の前は電柱を置かない（家へ入る通り道）
    for (let j = this.poles.length - 1; j >= 0; j--) {
      const p = this.poles[j];
      if (Math.abs(p.x - gateX) < 2.2 && Math.abs(p.z - wallZ) < w) this.poles.splice(j, 1);
    }

    // 門のところだけ北側の塀を開ける
    cutWalls(sideB, rect(porch.x0, porch.x1, wallZ - 0.01, wallZ + 0.01));

    for (const segs of [sideA, sideB]) {
      for (const s of segs) this.walls.push(wall(s.x1, s.z1, s.x2, s.z2, s.nx, s.nz, true));
    }
    // 突き当たり
    this.walls.push(wall(capA.x2, capA.z2, capB.x2, capB.z2, -1, 0));
    // 玄関までのアプローチの両脇の生け垣と玄関
    this.walls.push(wall(porch.x0, porch.z0, porch.x0, porch.z1, -1, 0, false, 'hedge'));
    this.walls.push(wall(porch.x1, porch.z0, porch.x1, porch.z1, 1, 0, false, 'hedge'));
    this.walls.push(wall(porch.x0, porch.z1, porch.x1, porch.z1, 0, 1, false, 'plain'));

    // 帰り道の中心線
    this.route.push([SW_MID, -2], [SW_MID, cz]);
    for (let i = 1; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (i === last) this.route.push([gateX, z]);
      else this.route.push([x, z]);
    }
    this.route.push([gateX, porch.z1 - 0.8]);
  }

  private buildTraffic(zEnd: number) {
    const d = this.difficulty;
    const interval: [number, number] = { easy: [8, 14], normal: [5, 11], hard: [3.5, 8] }[d] as [number, number];
    const south: CarStop[] = [];
    const north: CarStop[] = [];
    this.intersections.forEach((x, i) => {
      south.push({ at: x.rz1 + 0.6, signal: i, group: 'A' });
      north.push({ at: x.rz0 - 0.6, signal: i, group: 'A' });
    });
    this.carRoads.push({
      rect: this.roadA,
      crossing: 'gap',
      lanes: [
        // 歩道側の車線は向こうから来る（南行き）ので早めに見える
        { axis: 'z', c: 1.3, dir: -1, sStart: zEnd, sEnd: ROAD_A_Z0, cruise: 8, interval, stops: south },
        { axis: 'z', c: 4.3, dir: 1, sStart: ROAD_A_Z0, sEnd: zEnd, cruise: 8, interval, stops: north },
      ],
    });
  }

  // ---------- 問い合わせ ----------

  /** 地面の高さ（歩道の上は縁石の高さ） */
  groundAt(x: number, z: number): number {
    for (const r of this.sidewalks) if (inRect(r, x, z)) return CURB_HEIGHT;
    return 0;
  }

  sidewalkAt(x: number, z: number): Rect | null {
    return this.sidewalks.find((r) => inRect(r, x, z)) ?? null;
  }

  /** 石の中心位置が回収不能な場所か */
  hazardAt(x: number, z: number): { kind: Hazard; rect: Rect } | null {
    for (const g of this.grates) if (inRect(g, x, z)) return { kind: 'grate', rect: g };
    for (const g of this.gutters) {
      if (!inRect(g.rect, x, z)) continue;
      if (g.lids.some((l) => inRect(l, x, z))) continue;
      return { kind: 'gutter', rect: g.rect };
    }
    for (const l of this.lostZones) if (inRect(l.rect, x, z)) return { kind: l.kind, rect: l.rect };
    return null;
  }

  /** 車道の上か（大通りを先に見るので、交差点の中は大通り扱い） */
  carRoadAt(x: number, z: number): CarRoad | null {
    return this.carRoads.find((r) => inRect(r.rect, x, z)) ?? null;
  }

  isAtHome(x: number, z: number) {
    return inRect(this.home.mat, x, z);
  }

  /** 点を帰り道へ投影したときの、学校からの道のり */
  routeProgress(x: number, z: number): number {
    let best = Infinity;
    let bestS = 0;
    let acc = 0;
    for (let i = 0; i < this.routeLens.length; i++) {
      const [ax, az] = this.route[i];
      const [bx, bz] = this.route[i + 1];
      const l = this.routeLens[i];
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
  routePoint(s: number): [number, number] {
    let acc = 0;
    for (let i = 0; i < this.routeLens.length; i++) {
      const l = this.routeLens[i];
      if (s <= acc + l || i === this.routeLens.length - 1) {
        const t = Math.max(0, Math.min(1, (s - acc) / l));
        const [ax, az] = this.route[i];
        const [bx, bz] = this.route[i + 1];
        return [ax + (bx - ax) * t, az + (bz - az) * t];
      }
      acc += l;
    }
    const [x, z] = this.route[this.route.length - 1];
    return [x, z];
  }
}

// ---------- 路地の折れ線 ----------

interface Seg {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  nx: number;
  nz: number;
}

/** 区間 i の、進行方向に対する左右（side=1 で (-dz, dx) 側）の法線 */
function legNormal(pts: [number, number][], i: number, side: number): [number, number] {
  const dx = Math.sign(pts[i + 1][0] - pts[i][0]);
  const dz = Math.sign(pts[i + 1][1] - pts[i][1]);
  return [-dz * side, dx * side];
}

/** 直角に折れる中心線を d だけ横にずらした折れ線（外向き法線つき） */
function offsetPolyline(pts: [number, number][], d: number): Seg[] {
  const side = Math.sign(d);
  const off = Math.abs(d);
  const normals = pts.slice(0, -1).map((_, i) => legNormal(pts, i, side));
  const verts = pts.map(([x, z], i) => {
    const n0 = normals[Math.max(0, i - 1)];
    const n1 = normals[Math.min(normals.length - 1, i)];
    // 角では両側の法線の和（直角なので留め継ぎになる）
    const same = n0[0] === n1[0] && n0[1] === n1[1];
    const nx = same ? n0[0] : n0[0] + n1[0];
    const nz = same ? n0[1] : n0[1] + n1[1];
    return [x + nx * off, z + nz * off] as [number, number];
  });
  return normals.map((n, i) => ({ x1: verts[i][0], z1: verts[i][1], x2: verts[i + 1][0], z2: verts[i + 1][1], nx: n[0], nz: n[1] }));
}

/** 塀の折れ線から、rect と重なる部分を切り取る（門や田んぼの開口） */
function cutWalls(segs: Seg[], r: Rect) {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const alongX = s.z1 === s.z2;
    const c = alongX ? s.z1 : s.x1;
    if (alongX ? c < r.z0 || c > r.z1 : c < r.x0 || c > r.x1) continue;
    const a = alongX ? Math.min(s.x1, s.x2) : Math.min(s.z1, s.z2);
    const b = alongX ? Math.max(s.x1, s.x2) : Math.max(s.z1, s.z2);
    const parts = subtractSpans(a, b, [alongX ? [r.x0, r.x1] : [r.z0, r.z1]]);
    const pieces = parts.map(([p, q]) =>
      alongX ? { ...s, x1: p, z1: c, x2: q, z2: c } : { ...s, x1: c, z1: p, x2: c, z2: q },
    );
    segs.splice(i, 1, ...pieces);
  }
}
