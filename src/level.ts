/**
 * 通学路の自動生成。描画（world.ts）・物理（stone.ts）・交通（traffic.ts）が共通で参照するデータ。
 *
 * 町は碁盤の目。南北・東西の通りが交わり、通りは「車道＋両側の歩道」か「車の来ない路地」。
 * 車道どうしの交差点には信号がある。帰り道は学校から家まで、交差点で曲がったり、
 * 横断歩道を渡って反対側の歩道へ移ったりしながら進む。路地には坂（上って下る）もある。
 *
 * 座標は +Z が北。車は左側通行。歩道は車道より一段（縁石の高さ）高い。
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

/** none は当たり判定だけ（家の正面など、別に描くもの） */
export type WallStyle = 'block' | 'fence' | 'shop' | 'hedge' | 'plain' | 'none';

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
  /** 電柱か、工事のコーン */
  kind?: 'pole' | 'cone';
}

/** 工事中のマンホール：ふたの開いた穴と、まわりのコーン */
export interface Roadwork {
  hole: Rect;
  cones: [number, number][];
}

/** A：南北の通りの車、B：東西の通りの車 */
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
  axis: 'x' | 'z';
  /** 通りの中心線の座標 */
  c: number;
}

/** 車道どうしの交差点（信号つき） */
export interface Intersection {
  x: number;
  z: number;
  /** 南北の通り・東西の通りの車道の半幅と、歩道まで含めた半幅 */
  vHalf: number;
  hHalf: number;
  vOuter: number;
  hOuter: number;
  /** 信号の位相のずれ [s] */
  phase: number;
}

export type Hazard = 'gutter' | 'grass' | 'grate' | 'water' | 'manhole';

export interface LostZone {
  kind: 'grass' | 'water' | 'manhole';
  rect: Rect;
}

/** 見た目だけの区画（world.ts が描き分ける） */
export interface Decor {
  kind: 'school' | 'shops' | 'paddy' | 'park' | 'lot';
  rect: Rect;
  /** shops：店の並ぶ通りの側（区画から見た外向き法線） */
  nx?: number;
  nz?: number;
}

/** 横断歩道（白線を引く範囲） */
export interface Crosswalk {
  rect: Rect;
  /** 横切る車道の向き（白線はこの向きに長い） */
  roadAxis: 'x' | 'z';
}

/** 路地の坂。s0 から s1 にかけて上って下る */
export interface Slope {
  axis: 'x' | 'z';
  c: number;
  half: number;
  s0: number;
  s1: number;
  height: number;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Home {
  /** 門の中心（塀の線上） */
  gx: number;
  gz: number;
  /** 通りから家の方へ向かう向き */
  nx: number;
  nz: number;
  porch: Rect;
  /** ここで石が止まればクリア */
  mat: Rect;
  /** 家の色の種（主人公ごとに外観を変える） */
  seed: number;
}

export const CURB_HEIGHT = 0.12;
export const GUTTER_W = 0.45;
const CAR_HALF = 3.3;
const SW = 2.5;
/** 町の外側（碁盤の外）にどれだけ道や家を続けるか */
const MARGIN = 60;

/** 通り */
export interface Street {
  /** 走る向きの軸。'z' は南北の通り（中心線は x = c） */
  axis: 'x' | 'z';
  index: number;
  c: number;
  kind: 'car' | 'lane';
  /** 車道（路地）の半幅 */
  half: number;
  /** 歩道まで含めた半幅 */
  outer: number;
  s0: number;
  s1: number;
}

type BlockKind = 'houses' | 'shops' | 'paddy' | 'park' | 'lot' | 'school' | 'home';

interface Block {
  bi: number;
  bj: number;
  rect: Rect;
  kind: BlockKind;
}

/** 帰り道の一区間：通り street を、side 側（車道なら歩道の側、路地なら 0）で、dir の向きに歩く */
interface RouteEdge {
  street: Street;
  side: -1 | 0 | 1;
  dir: 1 | -1;
  /** 区間の始まりと終わりで交わる通り */
  from: Street;
  to: Street;
}

const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  x1: Math.max(x0, x1),
  z0: Math.min(z0, z1),
  z1: Math.max(z0, z1),
});
const wall = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number, houses = true, style: WallStyle = 'block'): WallSeg =>
  ({ x1, z1, x2, z2, nx, nz, houses, style });

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

/** 通り s の上で、中心線から across、通りに沿って along の点 */
const pointOn = (s: Street, across: number, along: number): [number, number] => (s.axis === 'z' ? [across, along] : [along, across]);
/** 通りに沿った帯 [a0, a1]（across 方向は [b0, b1]）の矩形 */
const bandOn = (s: Street, b0: number, b1: number, a0: number, a1: number): Rect => (s.axis === 'z' ? rect(b0, b1, a0, a1) : rect(a0, a1, b0, b1));
/** 車道の通りで、歩道の中心までの距離。路地は中心を歩く */
const walkOffset = (s: Street) => (s.kind === 'car' ? s.half + SW / 2 : 0);

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'やさしい', normal: 'ふつう', hard: 'むずかしい' };

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
  readonly crosswalks: Crosswalk[] = [];
  readonly slopes: Slope[] = [];
  readonly roadworks: Roadwork[] = [];
  readonly decor: Decor[] = [];
  /** 家を置いてはいけない範囲 */
  readonly reserved: Rect[] = [];
  /** 車の来ない路地の路面 */
  readonly lanes: Rect[] = [];
  readonly route: [number, number][] = [];
  start = { x: 0, z: 0 };
  home!: Home;
  /** 町の範囲（地面の大きさ） */
  bounds!: Rect;
  /** 曲がった回数・横断歩道を渡った回数（タイトルに出す） */
  turns = 0;
  crossings = 0;

  private readonly streetsV: Street[] = [];
  private readonly streetsH: Street[] = [];
  private readonly blockMap = new Map<string, Block>();
  private readonly routeLens: number[] = [];
  routeLength = 0;

  constructor(readonly seed: number) {
    const rand = createRng(seed);
    const r = rand();
    this.difficulty = r < 0.3 ? 'easy' : r < 0.75 ? 'normal' : 'hard';
    this.generate(rand);
    for (let i = 0; i < this.route.length - 1; i++) {
      const l = Math.hypot(this.route[i + 1][0] - this.route[i][0], this.route[i + 1][1] - this.route[i][1]);
      this.routeLens.push(l);
      this.routeLength += l;
    }
  }

  /** 南北・東西のすべての通り */
  get streets(): readonly Street[] {
    return [...this.streetsV, ...this.streetsH];
  }

  get difficultyLabel() {
    return DIFFICULTY_LABEL[this.difficulty];
  }

  // ======================= 生成 =======================

  private generate(rand: () => number) {
    this.buildGrid(rand);
    const edges = this.planRoute(rand);
    this.assignBlocks(rand, edges);
    this.buildStreets(rand);
    this.buildRouteLine(rand, edges);
    this.buildCrossings();
    this.buildBlocks(rand);
    this.buildRouteDetails(rand, edges);
    this.buildLaneGutters(rand, edges);
    this.buildTraffic();
  }

  /** 南北・東西の通りを決める */
  private buildGrid(rand: () => number) {
    const d = this.difficulty;
    const nV = 3 + (rand() < 0.5 ? 1 : 0);
    const nH = 3 + (d === 'easy' ? 0 : rand() < 0.6 ? 1 : 0);
    const carP = { easy: 0.35, normal: 0.45, hard: 0.55 }[d];
    const laneW = () => (d === 'hard' && rand() < 0.5 ? 3.4 : d === 'easy' ? 4.6 : 4.4);
    const make = (axis: 'x' | 'z', n: number, list: Street[]) => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        const car = rand() < carP;
        const half = car ? CAR_HALF : laneW() / 2;
        list.push({ axis, index: i, c, kind: car ? 'car' : 'lane', half, outer: car ? half + SW : half, s0: 0, s1: 0 });
        c += 34 + Math.round(rand() * 10);
      }
    };
    make('z', nV, this.streetsV);
    make('x', nH, this.streetsH);
    // 車道が1本もない町にはしない
    if (![...this.streetsV, ...this.streetsH].some((s) => s.kind === 'car')) {
      const s = rand() < 0.5 ? this.streetsV[1] : this.streetsH[1];
      s.kind = 'car';
      s.half = CAR_HALF;
      s.outer = CAR_HALF + SW;
    }
    const V = this.streetsV;
    const H = this.streetsH;
    const x0 = V[0].c - V[0].outer - MARGIN;
    const x1 = V[V.length - 1].c + V[V.length - 1].outer + MARGIN;
    const z0 = H[0].c - H[0].outer - MARGIN;
    const z1 = H[H.length - 1].c + H[H.length - 1].outer + MARGIN;
    this.bounds = rect(x0, x1, z0, z1);
    for (const s of V) [s.s0, s.s1] = [z0, z1];
    for (const s of H) [s.s0, s.s1] = [x0, x1];
  }

  /** 交差点を伝って、学校から家までの道順を決める（北・東・西へ。同じ交差点は通らない） */
  private planRoute(rand: () => number): RouteEdge[] {
    const V = this.streetsV;
    const H = this.streetsH;
    const target = { easy: 3, normal: 4, hard: 5 }[this.difficulty] + (rand() < 0.5 ? 1 : 0);
    for (let attempt = 0; attempt < 40; attempt++) {
      let i = Math.floor(rand() * V.length);
      let j = 0;
      const nodes: [number, number][] = [[i, j]];
      const seen = new Set([`${i},${j}`]);
      let last: 'N' | 'E' | 'W' = 'N';
      while (nodes.length - 1 < target) {
        const opts: ('N' | 'E' | 'W')[] = [];
        if (j < H.length - 1 && !seen.has(`${i},${j + 1}`)) opts.push('N');
        if (i < V.length - 1 && !seen.has(`${i + 1},${j}`)) opts.push('E');
        if (i > 0 && !seen.has(`${i - 1},${j}`)) opts.push('W');
        if (opts.length === 0) break;
        // 最初は北へ出る。あとはまっすぐ進むか曲がるかを半々くらいで
        const move: 'N' | 'E' | 'W' = nodes.length === 1 ? 'N' : opts.includes(last) && rand() < 0.3 ? last : opts[Math.floor(rand() * opts.length)];
        if (!opts.includes(move)) break;
        if (move === 'N') j++;
        else if (move === 'E') i++;
        else i--;
        last = move;
        nodes.push([i, j]);
        seen.add(`${i},${j}`);
      }
      if (nodes.length - 1 < 3 || nodes[1][1] !== 1) continue;
      // 曲がる回数と、車道ぞいを歩く区間があるか（ふつう以上はどちらも求める）
      let turns = 0;
      for (let k = 2; k < nodes.length; k++) {
        const v1 = nodes[k - 1][0] === nodes[k - 2][0];
        const v2 = nodes[k][0] === nodes[k - 1][0];
        if (v1 !== v2) turns++;
      }
      const usesCar = nodes.slice(1).some(([ni, nj], k) => (nodes[k][0] === ni ? V[ni] : H[nj]).kind === 'car');
      const strict = this.difficulty !== 'easy' && attempt < 30;
      if (strict && (turns < 2 || !usesCar)) continue;

      // 区間ごとに通り・向き・歩く側を決める
      const edges: RouteEdge[] = [];
      for (let k = 0; k < nodes.length - 1; k++) {
        const [ai, aj] = nodes[k];
        const [bi, bj] = nodes[k + 1];
        const vertical = ai === bi;
        const street = vertical ? V[ai] : H[aj];
        const dir = (vertical ? Math.sign(bj - aj) : Math.sign(bi - ai)) as 1 | -1;
        const from = vertical ? H[aj] : V[ai];
        const to = vertical ? H[bj] : V[bi];
        let side: -1 | 0 | 1 = 0;
        if (street.kind === 'car') {
          const prev = edges[k - 1];
          // 同じ通りを続けるときは、ときどき反対側の歩道へ渡る
          side = prev && prev.street === street ? (rand() < 0.3 ? (-prev.side as -1 | 1) : prev.side) : rand() < 0.5 ? -1 : 1;
          if (side === 0) side = 1;
        }
        edges.push({ street, side, dir, from, to });
      }
      return edges;
    }
    // ここには来ないはずだが、念のため北へまっすぐ
    return [0, 1, 2].slice(0, H.length - 1).map((j) => ({ street: V[0], side: V[0].kind === 'car' ? 1 : 0, dir: 1, from: H[j], to: H[j + 1] }) as RouteEdge);
  }

  /** 区画（通りに囲まれた土地）。碁盤の外側も1周ぶん作る */
  private blockAt(bi: number, bj: number): Block {
    const key = `${bi},${bj}`;
    let b = this.blockMap.get(key);
    if (!b) {
      const V = this.streetsV;
      const H = this.streetsH;
      const x0 = bi < 0 ? this.bounds.x0 : V[bi].c + V[bi].outer;
      const x1 = bi + 1 >= V.length ? this.bounds.x1 : V[bi + 1].c - V[bi + 1].outer;
      const z0 = bj < 0 ? this.bounds.z0 : H[bj].c + H[bj].outer;
      const z1 = bj + 1 >= H.length ? this.bounds.z1 : H[bj + 1].c - H[bj + 1].outer;
      b = { bi, bj, rect: rect(x0, x1, z0, z1), kind: 'houses' };
      this.blockMap.set(key, b);
    }
    return b;
  }

  /** 区間 e の side 側（-1/1）にある区画 */
  private blockBeside(e: RouteEdge, side: number): Block {
    const s = e.street;
    if (s.axis === 'z') return this.blockAt(side < 0 ? s.index - 1 : s.index, Math.min(e.from.index, e.to.index));
    return this.blockAt(Math.min(e.from.index, e.to.index), side < 0 ? s.index - 1 : s.index);
  }

  /** 帰り道ぞいの区画の種類を決める（学校・家・商店・田んぼ・公園・空き地・住宅） */
  private assignBlocks(rand: () => number, edges: RouteEdge[]) {
    for (let i = -1; i < this.streetsV.length; i++) for (let j = -1; j < this.streetsH.length; j++) this.blockAt(i, j);
    const first = edges[0];
    const schoolSide = first.side || (rand() < 0.5 ? -1 : 1);
    this.blockBeside(first, schoolSide).kind = 'school';
    const lastE = edges[edges.length - 1];
    const homeSide = lastE.side || (rand() < 0.5 ? -1 : 1);
    this.homeSide = homeSide;
    this.blockBeside(lastE, homeSide).kind = 'home';

    const d = this.difficulty;
    const weights: [BlockKind, number][] = [
      ['houses', 3],
      ['shops', 1.4],
      ['paddy', d === 'easy' ? 0.5 : 1.2],
      ['park', 1],
      ['lot', d === 'easy' ? 0.4 : 0.9],
    ];
    const total = weights.reduce((a, [, w]) => a + w, 0);
    for (const e of edges) {
      for (const side of [-1, 1]) {
        const b = this.blockBeside(e, side);
        if (b.kind !== 'houses' || this.assigned.has(b)) continue;
        this.assigned.add(b);
        let x = rand() * total;
        for (const [k, w] of weights) {
          x -= w;
          if (x <= 0) {
            b.kind = k;
            break;
          }
        }
      }
    }
  }
  private homeSide = 1;
  private readonly assigned = new Set<Block>();

  /** 通りの路面・歩道・縁石・車線 */
  private buildStreets(rand: () => number) {
    const all = [...this.streetsV, ...this.streetsH];
    for (const s of all) {
      const cross = s.axis === 'z' ? this.streetsH : this.streetsV;
      const road = bandOn(s, s.c - s.half, s.c + s.half, s.s0, s.s1);
      this.roadways.push(road);
      if (s.kind === 'lane') {
        this.lanes.push(road);
        // 町の外れの行き止まり
        for (const end of [s.s0, s.s1]) {
          const [ax, az] = pointOn(s, s.c - s.half, end);
          const [bx, bz] = pointOn(s, s.c + s.half, end);
          const n = end === s.s0 ? -1 : 1;
          this.walls.push(wall(ax, az, bx, bz, s.axis === 'x' ? n : 0, s.axis === 'z' ? n : 0, false, 'plain'));
        }
        continue;
      }
      // 歩道：交わる通りの車道（路地なら路地の幅）で途切れる。角の四角は両方の通りの歩道に含める
      const holes = cross.map((c) => [c.c - c.half, c.c + c.half] as [number, number]);
      for (const side of [-1, 1]) {
        const b0 = s.c + side * s.half;
        const b1 = s.c + side * s.outer;
        for (const [a0, a1] of subtractSpans(s.s0, s.s1, holes)) this.sidewalks.push(bandOn(s, b0, b1, a0, a1));
      }
      // 通りの両端（町の外れ）
      for (const end of [s.s0, s.s1]) {
        const [ax, az] = pointOn(s, s.c - s.outer, end);
        const [bx, bz] = pointOn(s, s.c + s.outer, end);
        const n = end === s.s0 ? -1 : 1;
        this.walls.push(wall(ax, az, bx, bz, s.axis === 'x' ? n : 0, s.axis === 'z' ? n : 0, false, 'plain'));
      }
    }
    // 車道どうしの交差点に信号
    for (const v of this.streetsV) {
      for (const h of this.streetsH) {
        if (v.kind === 'car' && h.kind === 'car') {
          this.intersections.push({ x: v.c, z: h.c, vHalf: v.half, hHalf: h.half, vOuter: v.outer, hOuter: h.outer, phase: rand() * 30 });
        }
      }
    }
  }

  /** 帰り道の中心線（歩道の中心・路地の中心・横断歩道）を引く */
  private buildRouteLine(rand: () => number, edges: RouteEdge[]) {
    const pts = this.route;
    const lineOf = (e: RouteEdge) => e.street.c + e.side * walkOffset(e.street);
    // 学校の前から
    const e0 = edges[0];
    const startAlong = e0.from.c + e0.dir * (e0.from.outer + 4);
    const [sx, sz] = pointOn(e0.street, lineOf(e0), startAlong);
    this.start = { x: sx, z: sz };
    pts.push(pointOn(e0.street, lineOf(e0), e0.from.c + e0.dir * (e0.from.outer + 1)));

    for (let k = 0; k < edges.length - 1; k++) {
      const a = edges[k];
      const b = edges[k + 1];
      const node = a.to; // 交差点で交わる通り（a と直交）
      const inLine = lineOf(a);
      if (b.street === a.street) {
        // まっすぐ進む。歩く側を変えるなら、交差点の手前か先で通りを渡る
        const outLine = lineOf(b);
        if (outLine !== inLine) {
          const near = rand() < 0.5;
          const along = node.c + (near ? -a.dir : a.dir) * walkOffset(node);
          pts.push(pointOn(a.street, inLine, along), pointOn(a.street, outLine, along));
        }
        continue;
      }
      this.turns++;
      // 曲がる：b の歩く線は a の通りに沿った座標
      const outLine = lineOf(b);
      const crossNode = node.kind === 'car' && (outLine - node.c) * a.dir > 0;
      const crossIn = a.street.kind === 'car' && (inLine - a.street.c) * b.dir < 0;
      if (crossNode && crossIn && rand() < 0.5) {
        // 先に今の通りを手前の横断歩道で渡ってから、交わる通りを渡る（左側の横断歩道を使う）
        const nearAlong = node.c - a.dir * walkOffset(node);
        const mirror = 2 * a.street.c - inLine;
        pts.push(pointOn(a.street, inLine, nearAlong), pointOn(a.street, mirror, nearAlong), pointOn(a.street, mirror, outLine));
      } else {
        pts.push(pointOn(a.street, inLine, outLine));
      }
    }

    // 家：最後の区間の途中、家の側の塀に門
    const eL = edges[edges.length - 1];
    const s = eL.street;
    const a0 = eL.from.c + eL.dir * eL.from.outer;
    const a1 = eL.to.c - eL.dir * eL.to.outer;
    const along = a0 + (a1 - a0) * (0.55 + rand() * 0.15);
    const side = this.homeSide;
    const wallLine = s.c + side * s.outer;
    const [gx, gz] = pointOn(s, wallLine, along);
    const nx = s.axis === 'z' ? side : 0;
    const nz = s.axis === 'x' ? side : 0;
    const porch = s.axis === 'z' ? rect(gx, gx + nx * 2.2, gz - 1.2, gz + 1.2) : rect(gx - 1.2, gx + 1.2, gz, gz + nz * 2.2);
    const mat = s.axis === 'z' ? rect(gx - nx * 0.8, gx + nx * 2.2, gz - 1.2, gz + 1.2) : rect(gx - 1.2, gx + 1.2, gz - nz * 0.8, gz + nz * 2.2);
    this.home = { gx, gz, nx, nz, porch, mat, seed: (rand() * 2 ** 31) | 0 };
    pts.push(pointOn(s, lineOf(eL), along), [gx + nx * 1.4, gz + nz * 1.4]);
    // 門から玄関まで：両脇の生け垣と玄関
    const [ex, ez] = [gx + nx * 2.2, gz + nz * 2.2];
    for (const t of [-1.2, 1.2]) {
      const [ox, oz] = nx !== 0 ? [0, t] : [t, 0];
      this.walls.push(wall(gx + ox, gz + oz, ex + ox, ez + oz, Math.sign(ox), Math.sign(oz), false, 'hedge'));
    }
    const [fx, fz] = nx !== 0 ? [0, 1.2] : [1.2, 0];
    this.walls.push(wall(ex - fx, ez - fz, ex + fx, ez + fz, nx, nz, false, 'none'));
  }

  /** 帰り道が車道を横切るところに横断歩道。信号の交差点は四方とも */
  private buildCrossings() {
    const add = (s: Street, at: number, width: number) => {
      this.crosswalks.push({ rect: bandOn(s, s.c - s.half, s.c + s.half, at - width / 2, at + width / 2), roadAxis: s.axis });
      // 横断歩道の両端は縁石を切り下げる
      for (const side of [-1, 1]) this.rampCuts.push({ street: s, side, a0: at - width / 2, a1: at + width / 2 });
    };
    for (const x of this.intersections) {
      const v = this.streetsV.find((s) => s.c === x.x)!;
      const h = this.streetsH.find((s) => s.c === x.z)!;
      for (const side of [-1, 1]) {
        add(v, h.c + side * (h.half + SW / 2), SW);
        add(h, v.c + side * (v.half + SW / 2), SW);
      }
    }
    // 信号のない横断（路地の入口で車道を渡る）
    for (let i = 0; i < this.route.length - 1; i++) {
      const [ax, az] = this.route[i];
      const [bx, bz] = this.route[i + 1];
      const along = ax === bx ? 'z' : 'x';
      const streets = along === 'z' ? this.streetsH : this.streetsV;
      for (const s of streets) {
        if (s.kind !== 'car') continue;
        const lo = along === 'z' ? Math.min(az, bz) : Math.min(ax, bx);
        const hi = along === 'z' ? Math.max(az, bz) : Math.max(ax, bx);
        if (s.c - s.half < lo || s.c + s.half > hi) continue;
        this.crossings++;
        const at = along === 'z' ? ax : az;
        if (this.crosswalks.some((c) => inRect(c.rect, along === 'z' ? at : s.c, along === 'z' ? s.c : at))) continue;
        add(s, at, SW);
      }
    }
    // 縁石：歩道の車道側。横断歩道・切り下げで途切れる
    for (const s of [...this.streetsV, ...this.streetsH]) {
      if (s.kind !== 'car') continue;
      const cross = s.axis === 'z' ? this.streetsH : this.streetsV;
      const holes = cross.map((c) => [c.c - c.half, c.c + c.half] as [number, number]);
      for (const side of [-1, 1]) {
        const line = s.c + side * s.half;
        const cuts = this.rampCuts.filter((r) => r.street === s && r.side === side).map((r) => [r.a0, r.a1] as [number, number]);
        for (const [a0, a1] of subtractSpans(s.s0, s.s1, [...holes, ...cuts])) {
          const [x1, z1] = pointOn(s, line, a0);
          const [x2, z2] = pointOn(s, line, a1);
          this.curbs.push({ x1, z1, x2, z2, nx: s.axis === 'z' ? -side : 0, nz: s.axis === 'x' ? -side : 0 });
        }
      }
    }
  }
  private readonly rampCuts: { street: Street; side: number; a0: number; a1: number }[] = [];

  /** 区画の塀と、種類ごとの中身 */
  private buildBlocks(rand: () => number) {
    for (const b of this.blockMap.values()) {
      const r = b.rect;
      if (r.x1 - r.x0 < 1 || r.z1 - r.z0 < 1) continue;
      // 通りに面した辺（外向き法線が通りを向く）
      const faces: { x1: number; z1: number; x2: number; z2: number; nx: number; nz: number }[] = [
        { x1: r.x0, z1: r.z0, x2: r.x1, z2: r.z0, nx: 0, nz: -1 },
        { x1: r.x0, z1: r.z1, x2: r.x1, z2: r.z1, nx: 0, nz: 1 },
        { x1: r.x0, z1: r.z0, x2: r.x0, z2: r.z1, nx: -1, nz: 0 },
        { x1: r.x1, z1: r.z0, x2: r.x1, z2: r.z1, nx: 1, nz: 0 },
      ].filter((f) => this.faceOnStreet(f));
      // 塀の法線は「道の外側」＝区画の内側を向く
      const addWall = (f: (typeof faces)[number], houses: boolean, style: WallStyle, gaps: [number, number][] = []) => {
        const alongX = f.z1 === f.z2;
        const a = alongX ? f.x1 : f.z1;
        const c = alongX ? f.z1 : f.x1;
        for (const [p, q] of subtractSpans(a, alongX ? f.x2 : f.z2, gaps)) {
          this.walls.push(alongX ? wall(p, c, q, c, -f.nx, -f.nz, houses, style) : wall(c, p, c, q, -f.nx, -f.nz, houses, style));
        }
      };
      const inset = (m: number) => rect(r.x0 + m, r.x1 - m, r.z0 + m, r.z1 - m);
      switch (b.kind) {
        case 'houses':
          for (const f of faces) addWall(f, true, 'block');
          break;
        case 'home': {
          const h = this.home;
          for (const f of faces) {
            const onGate = f.nx === -h.nx && f.nz === -h.nz && Math.abs(f.nx !== 0 ? f.x1 - h.gx : f.z1 - h.gz) < 0.01;
            addWall(f, true, 'block', onGate ? [[(f.nx !== 0 ? h.gz : h.gx) - 1.2, (f.nx !== 0 ? h.gz : h.gx) + 1.2]] : []);
          }
          this.reserved.push(h.nx !== 0 ? rect(h.gx, h.gx + h.nx * 9, h.gz - 4, h.gz + 4) : rect(h.gx - 4, h.gx + 4, h.gz, h.gz + h.nz * 9));
          break;
        }
        case 'school':
          for (const f of faces) addWall(f, false, 'fence');
          this.decor.push({ kind: 'school', rect: r });
          this.reserved.push(r);
          break;
        case 'shops': {
          for (const f of faces) {
            const street = this.streetBehind(f);
            if (street?.kind === 'car') {
              addWall(f, false, 'shop');
              const depth = 8;
              const dr = f.nx !== 0 ? rect(f.x1, f.x1 - f.nx * depth, r.z0, r.z1) : rect(r.x0, r.x1, f.z1, f.z1 - f.nz * depth);
              this.decor.push({ kind: 'shops', rect: dr, nx: f.nx, nz: f.nz });
              this.reserved.push(dr);
            } else addWall(f, true, 'block');
          }
          break;
        }
        case 'paddy':
          // 塀はなく、区画まるごと田んぼ
          this.decor.push({ kind: 'paddy', rect: r });
          this.reserved.push(r);
          this.lostZones.push({ kind: 'water', rect: inset(0.15) });
          break;
        case 'park': {
          // 低い柵。帰り道に面した辺に入口
          for (const f of faces) {
            const alongX = f.z1 === f.z2;
            const len = alongX ? f.x2 - f.x1 : f.z2 - f.z1;
            const g0 = (alongX ? f.x1 : f.z1) + len * (0.3 + rand() * 0.4);
            addWall(f, false, 'fence', this.faceOnRoute(f) ? [[g0, g0 + 2.2]] : []);
          }
          this.decor.push({ kind: 'park', rect: r });
          this.reserved.push(r);
          this.lostZones.push({ kind: 'grass', rect: inset(0.6) });
          break;
        }
        case 'lot':
          // 帰り道に面した辺は開いていて、草むらに入ると見つからない
          for (const f of faces) if (!this.faceOnRoute(f)) addWall(f, false, 'block');
          this.decor.push({ kind: 'lot', rect: r });
          this.reserved.push(r);
          this.lostZones.push({ kind: 'grass', rect: inset(0.2) });
          break;
      }
    }
  }

  /** 区画の辺 f のすぐ外に通りがあるか */
  private faceOnStreet(f: { x1: number; z1: number; nx: number; nz: number }): boolean {
    return this.streetBehind(f) !== null;
  }

  /** 辺の外向き法線の先で、歩道（路地）の外縁がちょうどその辺に来る通り */
  private streetBehind(f: { x1: number; z1: number; nx: number; nz: number }): Street | null {
    if (f.nx !== 0) return this.streetsV.find((s) => Math.abs(s.c - f.nx * s.outer - f.x1) < 0.01) ?? null;
    return this.streetsH.find((s) => Math.abs(s.c - f.nz * s.outer - f.z1) < 0.01) ?? null;
  }

  /** 区画の辺 f が帰り道に面しているか（帰り道の中心線から 6 m 以内を通る） */
  private faceOnRoute(f: { x1: number; z1: number; x2: number; z2: number }): boolean {
    for (let i = 0; i < this.route.length - 1; i++) {
      const [ax, az] = this.route[i];
      const [bx, bz] = this.route[i + 1];
      for (let t = 0; t <= 1; t += 0.1) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const cx = Math.max(Math.min(f.x1, f.x2), Math.min(Math.max(f.x1, f.x2), x));
        const cz = Math.max(Math.min(f.z1, f.z2), Math.min(Math.max(f.z1, f.z2), z));
        if (Math.hypot(cx - x, cz - z) < 6) return true;
      }
    }
    return false;
  }

  /** 帰り道ぞいの細かいもの：車庫の切り下げ・集水ます・電柱・自転車・坂 */
  private buildRouteDetails(rand: () => number, edges: RouteEdge[]) {
    const d = this.difficulty;
    const spacing = { easy: 24, normal: 15, hard: 10 }[d];
    const slopeP = { easy: 0.25, normal: 0.4, hard: 0.5 }[d];
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      const s = e.street;
      // 区間の内側（交差点の歩道・路地の幅を除く）
      const lo = Math.min(e.from.c, e.to.c) + (e.from.c < e.to.c ? e.from.outer : e.to.outer) + 1;
      const hi = Math.max(e.from.c, e.to.c) - (e.from.c < e.to.c ? e.to.outer : e.from.outer) - 1;
      if (hi - lo < 6) continue;
      const busy = (a: number) =>
        this.crosswalks.some((c) => (s.axis === 'z' ? Math.abs((c.rect.z0 + c.rect.z1) / 2 - a) : Math.abs((c.rect.x0 + c.rect.x1) / 2 - a)) < 3) ||
        this.nearHome(s, a);
      if (s.kind === 'car') {
        const side = e.side;
        const curbLine = s.c + side * s.half;
        // 車庫の切り下げ
        if (rand() < 0.75) {
          const a = lo + 3 + rand() * Math.max(0, hi - lo - 8);
          if (!busy(a)) {
            this.ramps.push(bandOn(s, curbLine, curbLine + side * 0.6, a, a + 2.5));
            this.cutCurb(s, side, a, a + 2.5);
          }
        }
        // 集水ます：歩く側の路肩
        for (let a = lo + 3 + rand() * 5; a < hi - 2; a += spacing * (0.7 + rand() * 0.6)) {
          if (busy(a) || this.ramps.some((r) => inRect(r, ...pointOn(s, curbLine + side * 0.3, a), 1.2))) continue;
          this.grates.push(bandOn(s, curbLine, curbLine - side * 0.45, a, a + 0.7));
        }
        // 電柱：歩道の車道側の端
        if (rand() < 0.65) {
          const a = lo + 2 + rand() * (hi - lo - 4);
          if (!busy(a)) {
            const [px, pz] = pointOn(s, curbLine + side * 0.35, a);
            this.poles.push({ x: px, z: pz, radius: 0.16 });
          }
        }
        // 商店街の前：自転車や立て看板が歩道の外側の端に
        const blk = this.blockBeside(e, side);
        if (blk.kind === 'shops') {
          const n = d === 'easy' ? 1 : d === 'normal' ? 2 : 3;
          const outerLine = s.c + side * s.outer;
          for (let i = 0; i < n; i++) {
            const a = lo + 2 + ((i + rand() * 0.6) / n) * (hi - lo - 5);
            if (busy(a) || busy(a + 1.7)) continue;
            const bike = rand() < 0.65;
            this.blocks.push(bandOn(s, outerLine, outerLine - side * (bike ? 0.55 : 0.45), a, a + (bike ? 1.7 : 0.5)));
          }
        }
      } else {
        // 路地の坂（家のある区間と最初の区間は平ら）
        if (k > 0 && k < edges.length - 1 && hi - lo > 18 && rand() < slopeP) {
          this.slopes.push({ axis: s.axis, c: s.c, half: s.half, s0: lo, s1: hi, height: 0.8 + rand() * 0.8 });
        }
      }
    }
  }

  private cutCurb(s: Street, side: number, a0: number, a1: number) {
    const line = s.c + side * s.half;
    for (let i = this.curbs.length - 1; i >= 0; i--) {
      const c = this.curbs[i];
      const alongZ = c.x1 === c.x2;
      if ((s.axis === 'z') !== alongZ) continue;
      if (Math.abs((alongZ ? c.x1 : c.z1) - line) > 0.01) continue;
      const p = alongZ ? c.z1 : c.x1;
      const q = alongZ ? c.z2 : c.x2;
      const parts = subtractSpans(Math.min(p, q), Math.max(p, q), [[a0, a1]]);
      this.curbs.splice(i, 1, ...parts.map(([u, v]) => (alongZ ? { ...c, z1: u, z2: v } : { ...c, x1: u, x2: v })));
    }
  }

  /** 家の門の近く（側溝や電柱を置かない） */
  private nearHome(s: Street, a: number) {
    const h = this.home;
    const ga = s.axis === 'z' ? h.gz : h.gx;
    const gc = s.axis === 'z' ? h.gx : h.gz;
    return Math.abs(gc - s.c) <= s.outer + 0.1 && Math.abs(a - ga) < 3;
  }

  /** 路地の側溝（区間ごとに片側だけ）と路地の電柱 */
  private buildLaneGutters(rand: () => number, edges: RouteEdge[]) {
    const d = this.difficulty;
    const lidRatio = { easy: 0.65, normal: 0.45, hard: 0.25 }[d];
    const onRoute = new Set(edges.filter((e) => e.street.kind === 'lane').map((e) => `${e.street.axis}${e.street.index}:${Math.min(e.from.index, e.to.index)}`));
    // 工事中のマンホールの数（帰り道の広い路地に）
    let works = { easy: rand() < 0.5 ? 1 : 0, normal: 1 + (rand() < 0.5 ? 1 : 0), hard: 2 + (rand() < 0.5 ? 1 : 0) }[d];
    for (const s of [...this.streetsV, ...this.streetsH]) {
      if (s.kind !== 'lane') continue;
      const cross = s.axis === 'z' ? this.streetsH : this.streetsV;
      for (let j = 0; j < cross.length - 1; j++) {
        const lo = cross[j].c + cross[j].outer + 1.5;
        const hi = cross[j + 1].c - cross[j + 1].outer - 1.5;
        if (hi - lo < 4) continue;
        if (this.slopes.some((sl) => sl.axis === s.axis && sl.c === s.c && sl.s0 < hi && sl.s1 > lo)) continue;
        // 田んぼに面した側には側溝を置かない（その側は落ちたら終わり）
        const blockOn = (side: number) => (s.axis === 'z' ? this.blockAt(side < 0 ? s.index - 1 : s.index, j) : this.blockAt(j, side < 0 ? s.index - 1 : s.index));
        const sides = [-1, 1].filter((sd) => blockOn(sd).kind !== 'paddy' && blockOn(sd).kind !== 'lot');
        if (sides.length === 0) continue;
        const side = sides[Math.floor(rand() * sides.length)];
        const edge = s.c + side * s.half;
        const g = bandOn(s, edge, edge - side * GUTTER_W, lo, hi);
        const lids: Rect[] = [];
        for (let t = lo; t < hi; ) {
          const len = 1.5 + rand() * 4;
          if (rand() < lidRatio || this.nearHome(s, t) || this.nearHome(s, t + len)) lids.push(bandOn(s, edge, edge - side * GUTTER_W, t, Math.min(hi, t + len)));
          t += len + 0.5;
        }
        // 家の門の前はかならずふた
        const h = this.home;
        const ga = s.axis === 'z' ? h.gz : h.gx;
        if (this.nearHome(s, ga) && ga > lo - 2 && ga < hi + 2) lids.push(bandOn(s, edge, edge - side * GUTTER_W, ga - 1.8, ga + 1.8));
        this.gutters.push({ rect: g, lids });
        // 工事中のマンホール（側溝の反対側）。帰り道の中心から 0.9 m 以上はなす
        const routeLane = onRoute.has(`${s.axis}${s.index}:${j}`);
        if (routeLane && works > 0 && s.half >= 1.65 && hi - lo > 10 && rand() < 0.9) {
          const t = lo + 3 + rand() * (hi - lo - 6);
          if (!this.nearHome(s, t) && Math.abs(t - (s.axis === 'z' ? h.gz : h.gx)) > 5) {
            works--;
            const inner = s.c - side * 0.9;
            const outer = s.c - side * (s.half - 0.2);
            const mid = (inner + outer) / 2;
            const hole = bandOn(s, mid - 0.32, mid + 0.32, t - 0.32, t + 0.32);
            const cones: [number, number][] = [];
            for (const b of [inner, outer]) for (const a of [t - 0.7, t + 0.7]) cones.push(pointOn(s, b, a));
            this.roadworks.push({ hole, cones });
            this.lostZones.push({ kind: 'manhole', rect: hole });
            for (const [cx, cz] of cones) this.poles.push({ x: cx, z: cz, radius: 0.14, kind: 'cone' });
            continue;
          }
        }
        // 帰り道の路地には電柱（側溝の反対側）
        if (routeLane && rand() < 0.7) {
          const t = lo + 1 + rand() * (hi - lo - 2);
          if (!this.nearHome(s, t)) {
            const [px, pz] = pointOn(s, s.c - side * (s.half - 0.3), t);
            this.poles.push({ x: px, z: pz, radius: 0.16 });
          }
        }
      }
    }
  }

  private buildTraffic() {
    const d = this.difficulty;
    const interval: [number, number] = { easy: [8, 14], normal: [5, 11], hard: [3.5, 8] }[d] as [number, number];
    for (const s of [...this.streetsV, ...this.streetsH]) {
      if (s.kind !== 'car') continue;
      const group: SignalGroup = s.axis === 'z' ? 'A' : 'B';
      const stops = (dir: 1 | -1): CarStop[] =>
        this.intersections
          .map((x, i) => ({ x, i }))
          .filter(({ x }) => (s.axis === 'z' ? x.x === s.c : x.z === s.c))
          .map(({ x, i }) => {
            const crossC = s.axis === 'z' ? x.z : x.x;
            const crossOuter = s.axis === 'z' ? x.hOuter : x.vOuter;
            return { at: crossC - dir * (crossOuter + 0.6), signal: i, group };
          });
      // 左側通行：進む向きの左側の車線を走る
      const off = s.half / 2;
      const lanes: CarLaneDef[] = ([1, -1] as const).map((dir) => ({
        axis: s.axis,
        c: s.axis === 'z' ? s.c + dir * off : s.c - dir * off,
        dir,
        sStart: dir > 0 ? s.s0 : s.s1,
        sEnd: dir > 0 ? s.s1 : s.s0,
        cruise: 8 + (s.axis === 'x' ? 1 : 0),
        interval,
        stops: stops(dir),
      }));
      this.carRoads.push({ rect: bandOn(s, s.c - s.half, s.c + s.half, s.s0, s.s1), lanes, axis: s.axis, c: s.c });
    }
  }

  // ======================= 問い合わせ =======================

  /** 坂の高さ（路地の上だけ） */
  terrainAt(x: number, z: number): number {
    for (const sl of this.slopes) {
      const across = sl.axis === 'z' ? x : z;
      const along = sl.axis === 'z' ? z : x;
      if (Math.abs(across - sl.c) > sl.half + 0.001 || along < sl.s0 || along > sl.s1) continue;
      return sl.height * Math.sin((Math.PI * (along - sl.s0)) / (sl.s1 - sl.s0));
    }
    return 0;
  }

  /** 地面の高さ（歩道の上は縁石の高さ、坂の上は坂の高さ） */
  groundAt(x: number, z: number): number {
    for (const r of this.sidewalks) if (inRect(r, x, z)) return CURB_HEIGHT;
    return this.slopes.length ? this.terrainAt(x, z) : 0;
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

  /** 半径 r の円（子ども）を塀・電柱・自転車などの外へ押し出す */
  pushOutCircle(p: { x: number; z: number }, r: number) {
    const push = (cx: number, cz: number, min: number) => {
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= min || d < 1e-6) return;
      p.x = cx + (dx / d) * min;
      p.z = cz + (dz / d) * min;
    };
    // 角では2つの塀に挟まれるので、2回まわして落ち着かせる
    for (let k = 0; k < 2; k++) {
      for (const w of this.walls) {
        const sx = w.x2 - w.x1;
        const sz = w.z2 - w.z1;
        const l2 = sx * sx + sz * sz;
        if (l2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((p.x - w.x1) * sx + (p.z - w.z1) * sz) / l2));
        push(w.x1 + sx * t, w.z1 + sz * t, r);
      }
      for (const pole of this.poles) push(pole.x, pole.z, r + pole.radius);
      for (const b of this.blocks) push(Math.max(b.x0, Math.min(b.x1, p.x)), Math.max(b.z0, Math.min(b.z1, p.z)), r);
    }
  }

  /** 2点の間を塀がさえぎっていないか */
  clearPath(ax: number, az: number, bx: number, bz: number): boolean {
    const cross = (ux: number, uz: number, vx: number, vz: number) => ux * vz - uz * vx;
    for (const w of this.walls) {
      const d1 = cross(bx - ax, bz - az, w.x1 - ax, w.z1 - az);
      const d2 = cross(bx - ax, bz - az, w.x2 - ax, w.z2 - az);
      const d3 = cross(w.x2 - w.x1, w.z2 - w.z1, ax - w.x1, az - w.z1);
      const d4 = cross(w.x2 - w.x1, w.z2 - w.z1, bx - w.x1, bz - w.z1);
      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
    return true;
  }

  /** 車道の上か */
  carRoadAt(x: number, z: number): CarRoad | null {
    return this.carRoads.find((r) => inRect(r.rect, x, z)) ?? null;
  }

  /** 車道のこの位置を渡るとき、従う信号（交差点の横断歩道なら）。なければ -1 */
  signalFor(road: CarRoad, x: number, z: number): number {
    return this.intersections.findIndex((it) =>
      road.axis === 'z' ? it.x === road.c && Math.abs(z - it.z) <= it.hOuter + 0.3 : it.z === road.c && Math.abs(x - it.x) <= it.vOuter + 0.3,
    );
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
      if (l < 1e-6) continue;
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
        const t = l > 1e-6 ? Math.max(0, Math.min(1, (s - acc) / l)) : 1;
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
