import * as THREE from 'three';
import type { CarLaneDef, CarRoad, Intersection, Level, Rect, SignalGroup } from './level';

const CAR_LEN = 3.8;
const CAR_HALF_W = 0.85;
const ACCEL = 2.5;
const BRAKE = 7;
/** 子どもが車線内にいるとき、車がこの距離手前で止まる */
const KID_STOP_GAP = 1.6;
/** 車線の中心からこの距離以内に子どもがいれば「車線内」とみなす（歩道の上は含まない） */
const LANE_BAND = 1.7;

export type CarLight = 'green' | 'yellow' | 'red';
export type PedLight = 'green' | 'blink' | 'red';

/**
 * 交差点の信号。大通り（B）と道A（A）が交互に青になる。
 * 大通りを渡る横断歩道は、道Aと同じ時に青になる（並行する車は曲がらない）。
 */
export class Signal {
  private static readonly B_GREEN = 11;
  private static readonly YELLOW = 2.5;
  private static readonly ALL_RED = 1.5;
  private static readonly A_GREEN = 12;
  private static readonly PED_GREEN = 8;
  private static readonly PED_BLINK = 3;
  private static readonly A_START = Signal.B_GREEN + Signal.YELLOW + Signal.ALL_RED;
  private static readonly CYCLE = Signal.A_START + Signal.A_GREEN + Signal.YELLOW + Signal.ALL_RED;

  t = 0;

  constructor(readonly phase = 0) {
    this.t = phase % Signal.CYCLE;
  }

  update(dt: number) {
    this.t = (this.t + dt) % Signal.CYCLE;
  }

  car(group: SignalGroup): CarLight {
    const start = group === 'B' ? 0 : Signal.A_START;
    const green = group === 'B' ? Signal.B_GREEN : Signal.A_GREEN;
    const t = this.t - start;
    if (t >= 0 && t < green) return 'green';
    if (t >= green && t < green + Signal.YELLOW) return 'yellow';
    return 'red';
  }

  /**
   * 歩行者用。roadAxis の向きに走る車道を渡る横断歩道の信号。
   * 渡る人は交わる側の車と同じ向きに進むので、そちらの車が青のときに青になる。
   */
  ped(roadAxis: 'x' | 'z'): PedLight {
    const t = this.t - (roadAxis === 'x' ? Signal.A_START : 0);
    if (t >= 0 && t < Signal.PED_GREEN) return 'green';
    if (t >= Signal.PED_GREEN && t < Signal.PED_GREEN + Signal.PED_BLINK) return 'blink';
    return 'red';
  }
}

/** 車線に沿った座標 s と、直交する座標 c に分ける */
const along = (lane: CarLaneDef, x: number, z: number) => (lane.axis === 'x' ? x : z);
const across = (lane: CarLaneDef, x: number, z: number) => (lane.axis === 'x' ? z : x);

export class Car {
  readonly mesh: THREE.Group;
  speed: number;

  constructor(readonly lane: CarLaneDef, public s: number, color: number) {
    this.mesh = buildCarMesh(color);
    // 車のモデルは +Z が前
    this.mesh.rotation.y = lane.axis === 'x' ? lane.dir * (Math.PI / 2) : lane.dir > 0 ? 0 : Math.PI;
    this.speed = lane.cruise;
    this.sync();
  }

  get front() {
    return this.s + this.lane.dir * (CAR_LEN / 2);
  }

  get rect(): Rect {
    const { c, axis } = this.lane;
    return axis === 'x'
      ? { x0: this.s - CAR_LEN / 2, x1: this.s + CAR_LEN / 2, z0: c - CAR_HALF_W, z1: c + CAR_HALF_W }
      : { x0: c - CAR_HALF_W, x1: c + CAR_HALF_W, z0: this.s - CAR_LEN / 2, z1: this.s + CAR_LEN / 2 };
  }

  sync() {
    if (this.lane.axis === 'x') this.mesh.position.set(this.s, 0, this.lane.c);
    else this.mesh.position.set(this.lane.c, 0, this.s);
  }
}

interface Warning {
  mesh: THREE.Mesh;
  lane: CarLaneDef;
}

interface SignalLights {
  car: { signal: number; group: SignalGroup; mats: Record<CarLight, THREE.MeshBasicMaterial> }[];
  ped: { signal: number; axis: 'x' | 'z'; red: THREE.MeshBasicMaterial; green: THREE.MeshBasicMaterial }[];
}

/** 車の出現・走行・信号停止と、石や子どもとの関わりを扱う */
export class Traffic {
  readonly group = new THREE.Group();
  /** 交差点ごとの信号 */
  readonly signals: Signal[];
  cars: Car[] = [];

  private readonly timers = new Map<CarLaneDef, number>();
  private readonly lights: SignalLights;
  private readonly warnings: Warning[] = [];
  private time = 0;

  constructor(private readonly level: Level) {
    this.signals = level.intersections.map((x) => new Signal(x.phase));
    this.lights = { car: [], ped: [] };
    level.intersections.forEach((x, i) => buildSignals(this.group, x, i, this.lights));
    const chevron = new THREE.Shape([
      new THREE.Vector2(-0.35, 0.5), new THREE.Vector2(0.25, 0), new THREE.Vector2(-0.35, -0.5),
      new THREE.Vector2(-0.1, 0), new THREE.Vector2(-0.35, 0.5),
    ]);
    const geo = new THREE.ShapeGeometry(chevron);
    geo.rotateX(-Math.PI / 2);
    for (const road of level.carRoads) {
      for (const lane of road.lanes) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffc83a, transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        // 矢印は +X 向き。車の進む向きへ回す
        mesh.rotation.y = lane.axis === 'x' ? (lane.dir > 0 ? 0 : Math.PI) : -lane.dir * (Math.PI / 2);
        mesh.renderOrder = 3;
        mesh.visible = false;
        this.group.add(mesh);
        this.warnings.push({ mesh, lane });
      }
    }
  }

  /** 車を全部消して、少し走らせた状態から始める */
  reset() {
    for (const c of this.cars) this.group.remove(c.mesh);
    this.cars = [];
    this.timers.clear();
    for (let i = 0; i < 400; i++) this.update(0.1, []);
  }

  /** 使い終わった車や信号の形状を片付ける */
  dispose() {
    for (const c of this.cars) this.group.remove(c.mesh);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }

  /** people：車が止まる相手（子ども・通行人・犬）。石には気づかない */
  update(dt: number, people: readonly { x: number; z: number }[]) {
    this.time += dt;
    for (const s of this.signals) s.update(dt);

    for (const road of this.level.carRoads) {
      for (const lane of road.lanes) {
        const t = (this.timers.get(lane) ?? Math.random() * lane.interval[1]) - dt;
        if (t <= 0) {
          const clear = !this.cars.some((c) => c.lane === lane && Math.abs(c.s - lane.sStart) < CAR_LEN + 6);
          if (clear) this.spawn(lane);
          this.timers.set(lane, lane.interval[0] + Math.random() * (lane.interval[1] - lane.interval[0]));
        } else {
          this.timers.set(lane, t);
        }
      }
    }

    for (const car of this.cars) {
      const lane = car.lane;
      const dir = lane.dir;
      let gap = Infinity;

      // 前の車
      for (const other of this.cars) {
        if (other === car || other.lane !== lane) continue;
        const d = (other.s - car.s) * dir - CAR_LEN;
        if (d > -CAR_LEN && d < gap) gap = d - 2;
      }
      // 信号（この先にある交差点のうち、赤・黄のもの）
      for (const stop of lane.stops) {
        const light = this.signals[stop.signal].car(stop.group);
        if (light === 'green') continue;
        const d = (stop.at - car.front) * dir;
        const canStop = d > (car.speed * car.speed) / (2 * BRAKE) - 0.5;
        if (d > -0.5 && (light === 'red' || canStop)) gap = Math.min(gap, d);
      }
      // 車線にいる子どもや通行人（石には気づかない）
      for (const kid of people) {
        if (Math.abs(across(lane, kid.x, kid.z) - lane.c) >= LANE_BAND) continue;
        const d = (along(lane, kid.x, kid.z) - car.front) * dir;
        if (d > -0.8 && d < 18) gap = Math.min(gap, d - KID_STOP_GAP);
      }

      const target = Math.min(lane.cruise, Math.sqrt(Math.max(0, 2 * BRAKE * 0.8 * gap)));
      if (car.speed < target) car.speed = Math.min(target, car.speed + ACCEL * dt);
      else car.speed = Math.max(target, car.speed - BRAKE * 1.3 * dt);
      car.s += dir * car.speed * dt;
      car.sync();
    }

    const gone = this.cars.filter((c) => (c.s - c.lane.sEnd) * c.lane.dir > 0);
    if (gone.length) {
      for (const c of gone) this.group.remove(c.mesh);
      this.cars = this.cars.filter((c) => !gone.includes(c));
    }

    this.updateLights();
  }

  private spawn(lane: CarLaneDef) {
    const colors = [0xf4f1ea, 0xd8d9db, 0x3a3f47, 0xb8332b, 0x2f5d8a, 0xe7c45a, 0x6d8b74];
    const car = new Car(lane, lane.sStart, colors[Math.floor(Math.random() * colors.length)]);
    this.cars.push(car);
    this.group.add(car.mesh);
  }

  /** 走っている車が石に当たったか。当たった車を返す */
  hitTest(x: number, z: number, y: number, radius: number): Car | null {
    if (y > 0.9) return null;
    for (const car of this.cars) {
      if (car.speed < 0.6) continue;
      const r = car.rect;
      if (x > r.x0 - radius && x < r.x1 + radius && z > r.z0 - radius && z < r.z1 + radius) return car;
    }
    return null;
  }

  /** 止まっている車は石が跳ね返る箱として扱う */
  get obstacles(): Rect[] {
    return this.cars.filter((c) => c.speed < 0.6).map((c) => c.rect);
  }

  /**
   * 子どもがこの車道へ降りてよいか。(tx, tz) は行き先で、その近くの車線だけを見る。
   */
  mayCross(road: CarRoad, x: number, z: number, tx: number, tz: number): boolean {
    const signal = this.level.signalFor(road, x, z);
    if (signal >= 0) return this.signals[signal].ped(road.axis) === 'green';
    return !this.cars.some((c) => {
      if (!road.lanes.includes(c.lane)) return false;
      if (Math.abs(across(c.lane, tx, tz) - c.lane.c) > 2.2) return false;
      const ahead = (along(c.lane, x, z) - c.s) * c.lane.dir;
      return ahead > -CAR_LEN && ahead < 18;
    });
  }

  /** いちばん近い走行中の車までの距離（走行音用） */
  nearestCar(x: number, z: number): number {
    let best = Infinity;
    for (const c of this.cars) {
      if (c.speed < 0.6) continue;
      const r = c.rect;
      const dx = Math.max(r.x0 - x, 0, x - r.x1);
      const dz = Math.max(r.z0 - z, 0, z - r.z1);
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  /** 車道の近くにある石へ車が近づいていれば、路面の矢印で知らせる */
  updateWarnings(stoneX: number, stoneZ: number) {
    for (const w of this.warnings) {
      const lane = w.lane;
      let best = Infinity;
      if (Math.abs(across(lane, stoneX, stoneZ) - lane.c) < 2.7) {
        const s = along(lane, stoneX, stoneZ);
        for (const c of this.cars) {
          if (c.lane !== lane || c.speed < 0.6) continue;
          const d = (s - c.front) * lane.dir;
          if (d > 0 && d < best) best = d;
        }
      }
      const show = best < 40;
      w.mesh.visible = show;
      if (show) {
        const s = along(lane, stoneX, stoneZ) - lane.dir * Math.min(best, 5.5);
        if (lane.axis === 'x') w.mesh.position.set(s, 0.02, lane.c);
        else w.mesh.position.set(lane.c, 0.02, s);
        (w.mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.45 * Math.abs(Math.sin(this.time * (best < 15 ? 9 : 4)));
      }
    }
  }

  private updateLights() {
    for (const head of this.lights.car) {
      const light = this.signals[head.signal].car(head.group);
      for (const k of ['green', 'yellow', 'red'] as const) head.mats[k].color.setHex(k === light ? LIT[k] : DIM);
    }
    for (const head of this.lights.ped) {
      const signal = this.signals[head.signal];
      const ped = signal.ped(head.axis);
      const blinkOn = ped === 'green' || (ped === 'blink' && Math.floor(signal.t * 3) % 2 === 0);
      head.green.color.setHex(blinkOn ? LIT.green : DIM);
      head.red.color.setHex(ped === 'red' ? LIT.red : DIM);
    }
  }
}

const LIT = { green: 0x35d4a0, yellow: 0xffb52e, red: 0xff4a3a };
const DIM = 0x2c2f33;

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** 車の形と材質は全部の車で共有する（出ては消えるので毎回作ると GPU のメモリが増え続ける） */
const carParts = (() => {
  const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10);
  wheel.rotateZ(Math.PI / 2);
  return {
    body: new THREE.BoxGeometry(CAR_HALF_W * 2, 0.7, CAR_LEN),
    cabin: new THREE.BoxGeometry(CAR_HALF_W * 2 - 0.15, 0.55, 2.0),
    roof: new THREE.BoxGeometry(CAR_HALF_W * 2 - 0.2, 0.06, 1.8),
    wheel,
    lamp: new THREE.BoxGeometry(0.3, 0.12, 0.05),
    glass: lambert(0x3d4a57),
    tire: lambert(0x222222),
    light: new THREE.MeshBasicMaterial({ color: 0xfff2c4 }),
    paint: new Map<number, THREE.Material>(),
  };
})();

function buildCarMesh(color: number): THREE.Group {
  const P = carParts;
  let paint = P.paint.get(color);
  if (!paint) P.paint.set(color, (paint = lambert(color)));
  const g = new THREE.Group();
  const body = new THREE.Mesh(P.body, paint);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const cabin = new THREE.Mesh(P.cabin, P.glass);
  cabin.position.set(0, 1.17, -0.25);
  cabin.castShadow = true;
  g.add(cabin);
  const roof = new THREE.Mesh(P.roof, paint);
  roof.position.set(0, 1.47, -0.3);
  g.add(roof);
  for (const [x, z] of [[-0.8, 1.2], [0.8, 1.2], [-0.8, -1.2], [0.8, -1.2]]) {
    const w = new THREE.Mesh(P.wheel, P.tire);
    w.position.set(x, 0.3, z);
    g.add(w);
  }
  for (const x of [-0.55, 0.55]) {
    const lamp = new THREE.Mesh(P.lamp, P.light);
    lamp.position.set(x, 0.65, CAR_LEN / 2 + 0.01);
    g.add(lamp);
  }
  return g;
}

/** 交差点に車用・歩行者用の信号機を立てる */
function buildSignals(group: THREE.Group, x: Intersection, index: number, lights: SignalLights) {
  const poleMat = lambert(0x8e8a84);
  const housingMat = lambert(0x5d6066);
  const lampGeo = new THREE.CircleGeometry(0.11, 12);

  const pole = (x: number, z: number, h: number) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, h, 8), poleMat);
    p.position.set(x, h / 2 + 0.12, z);
    p.castShadow = true;
    group.add(p);
  };

  // 車用：角の柱から車線の上へ腕を伸ばす。facing は信号の正面が向く方向
  const carHead = (signal: SignalGroup, x: number, z: number, facing: number, px: number, pz: number) => {
    pole(px, pz, 4.6);
    const len = Math.hypot(x - px, z - pz);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, len), poleMat);
    arm.position.set((x + px) / 2, 4.6, (z + pz) / 2);
    arm.rotation.y = Math.atan2(x - px, z - pz);
    group.add(arm);
    const head = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.32, 0.22), housingMat);
    box.castShadow = true;
    head.add(box);
    const mats = {} as Record<CarLight, THREE.MeshBasicMaterial>;
    (['green', 'yellow', 'red'] as const).forEach((k, i) => {
      const m = new THREE.MeshBasicMaterial({ color: DIM });
      const lamp = new THREE.Mesh(lampGeo, m);
      lamp.position.set(-0.3 + i * 0.3, 0, 0.115);
      head.add(lamp);
      mats[k] = m;
    });
    head.position.set(x, 4.4, z);
    head.rotation.y = facing;
    group.add(head);
    lights.car.push({ signal: index, group: signal, mats });
  };

  const pedHead = (axis: 'x' | 'z', px: number, pz: number, facing: number) => {
    pole(px, pz, 3);
    const head = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.2), housingMat);
    box.castShadow = true;
    head.add(box);
    const red = new THREE.MeshBasicMaterial({ color: DIM });
    const green = new THREE.MeshBasicMaterial({ color: DIM });
    const panel = new THREE.PlaneGeometry(0.28, 0.26);
    const r = new THREE.Mesh(panel, red);
    r.position.set(0, 0.16, 0.101);
    const gm = new THREE.Mesh(panel, green);
    gm.position.set(0, -0.16, 0.101);
    head.add(r, gm);
    head.position.set(px, 2.7, pz);
    head.rotation.y = facing;
    group.add(head);
    lights.ped.push({ signal: index, axis, red, green });
  };

  const { x: cx, z: cz, vHalf, hHalf, vOuter, hOuter } = x;
  // 車用：交差点の手前の角から、車線の上へ腕を伸ばす（左側通行）
  carHead('B', cx - vOuter - 0.4, cz - hHalf / 2, -Math.PI / 2, cx - vOuter - 0.4, cz - hHalf - 1.0);
  carHead('B', cx + vOuter + 0.4, cz + hHalf / 2, Math.PI / 2, cx + vOuter + 0.4, cz + hHalf + 1.0);
  carHead('A', cx + vHalf / 2, cz - hOuter - 0.4, Math.PI, cx + vHalf + 1.0, cz - hOuter - 0.4);
  carHead('A', cx - vHalf / 2, cz + hOuter + 0.4, 0, cx - vHalf - 1.0, cz + hOuter + 0.4);
  // 歩行者用：4つの横断歩道の両端に、渡ってくる人の方を向けて
  for (const side of [-1, 1]) {
    // 南北の車道を渡る横断歩道（z = cz ± …）
    const zc = cz + side * (hHalf + 1.25);
    pedHead('z', cx - vHalf - 0.5, zc + side * 1.6, Math.PI / 2);
    pedHead('z', cx + vHalf + 0.5, zc + side * 1.6, -Math.PI / 2);
    // 東西の車道を渡る横断歩道（x = cx ± …）
    const xc = cx + side * (vHalf + 1.25);
    pedHead('x', xc + side * 1.6, cz - hHalf - 0.5, 0);
    pedHead('x', xc + side * 1.6, cz + hHalf + 0.5, Math.PI);
  }
}
