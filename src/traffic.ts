import * as THREE from 'three';
import { CAR_ROADS, MAIN_ROAD, type CarLaneDef, type CarRoad, type Rect } from './level';

const CAR_LEN = 3.8;
const CAR_HALF_W = 0.85;
const ACCEL = 2.5;
const BRAKE = 7;
/** 子どもが車線内にいるとき、車がこの距離手前で止まる */
const KID_STOP_GAP = 1.6;
/** 車線の端からこの距離以内に子どもがいれば「車線内」とみなす */
const LANE_BAND = 2.0;

export type CarLight = 'green' | 'yellow' | 'red';
export type PedLight = 'green' | 'blink' | 'red';

/** 大通りの信号。車用と歩行者用が交互に青になる。 */
export class Signal {
  private static readonly CAR_GREEN = 11;
  private static readonly CAR_YELLOW = 2.5;
  private static readonly ALL_RED = 1.5;
  private static readonly PED_GREEN = 7;
  private static readonly PED_BLINK = 3;
  private static readonly CYCLE =
    Signal.CAR_GREEN + Signal.CAR_YELLOW + Signal.ALL_RED + Signal.PED_GREEN + Signal.PED_BLINK + Signal.ALL_RED;

  t = 0;

  update(dt: number) {
    this.t = (this.t + dt) % Signal.CYCLE;
  }

  get car(): CarLight {
    if (this.t < Signal.CAR_GREEN) return 'green';
    if (this.t < Signal.CAR_GREEN + Signal.CAR_YELLOW) return 'yellow';
    return 'red';
  }

  get ped(): PedLight {
    const start = Signal.CAR_GREEN + Signal.CAR_YELLOW + Signal.ALL_RED;
    if (this.t < start || this.t >= start + Signal.PED_GREEN + Signal.PED_BLINK) return 'red';
    return this.t < start + Signal.PED_GREEN ? 'green' : 'blink';
  }
}

export class Car {
  readonly mesh: THREE.Group;
  speed: number;

  constructor(readonly lane: CarLaneDef, public x: number, color: number) {
    this.mesh = buildCarMesh(color);
    this.mesh.rotation.y = lane.dir * (Math.PI / 2);
    this.speed = lane.cruise;
    this.sync();
  }

  get front() {
    return this.x + this.lane.dir * (CAR_LEN / 2);
  }

  get rect(): Rect {
    return { x0: this.x - CAR_LEN / 2, x1: this.x + CAR_LEN / 2, z0: this.lane.z - CAR_HALF_W, z1: this.lane.z + CAR_HALF_W };
  }

  sync() {
    this.mesh.position.set(this.x, 0, this.lane.z);
  }
}

interface Warning {
  mesh: THREE.Mesh;
  lane: CarLaneDef;
}

/** 車の出現・走行・信号停止と、石や子どもとの関わりを扱う */
export class Traffic {
  readonly group = new THREE.Group();
  readonly signal = new Signal();
  cars: Car[] = [];

  private readonly timers = new Map<CarLaneDef, number>();
  private readonly lights: { car: Record<CarLight, THREE.MeshBasicMaterial>[]; ped: Record<'red' | 'green', THREE.MeshBasicMaterial>[] };
  private readonly warnings: Warning[] = [];
  private time = 0;

  constructor() {
    this.lights = buildSignals(this.group);
    const chevron = new THREE.Shape([
      new THREE.Vector2(-0.35, 0.5), new THREE.Vector2(0.25, 0), new THREE.Vector2(-0.35, -0.5),
      new THREE.Vector2(-0.1, 0), new THREE.Vector2(-0.35, 0.5),
    ]);
    const geo = new THREE.ShapeGeometry(chevron);
    geo.rotateX(-Math.PI / 2);
    for (const road of CAR_ROADS) {
      for (const lane of road.lanes) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffc83a, transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.y = lane.dir > 0 ? 0 : Math.PI;
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
    this.signal.t = 0;
    for (let i = 0; i < 300; i++) this.update(0.1, null);
    this.signal.t = Math.random() * 6;
  }

  update(dt: number, kid: { x: number; z: number } | null) {
    this.time += dt;
    this.signal.update(dt);

    for (const road of CAR_ROADS) {
      for (const lane of road.lanes) {
        const t = (this.timers.get(lane) ?? Math.random() * lane.interval[1]) - dt;
        if (t <= 0) {
          const clear = !this.cars.some((c) => c.lane === lane && Math.abs(c.x - lane.xStart) < CAR_LEN + 6);
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
        const d = (other.x - car.x) * dir - CAR_LEN;
        if (d > -CAR_LEN && d < gap) gap = d - 2;
      }
      // 信号
      if (lane.stopX !== undefined && this.signal.car !== 'green') {
        const d = (lane.stopX - car.front) * dir;
        const canStop = d > (car.speed * car.speed) / (2 * BRAKE) - 0.5;
        if (d > -0.5 && (this.signal.car === 'red' || canStop)) gap = Math.min(gap, d);
      }
      // 車線にいる子ども（石には気づかない）
      if (kid && Math.abs(kid.z - lane.z) < LANE_BAND) {
        const d = (kid.x - car.front) * dir;
        if (d > -0.8 && d < 18) gap = Math.min(gap, d - KID_STOP_GAP);
      }

      const target = Math.min(lane.cruise, Math.sqrt(Math.max(0, 2 * BRAKE * 0.8 * gap)));
      if (car.speed < target) car.speed = Math.min(target, car.speed + ACCEL * dt);
      else car.speed = Math.max(target, car.speed - BRAKE * 1.3 * dt);
      car.x += dir * car.speed * dt;
      car.sync();
    }

    const gone = this.cars.filter((c) => (c.x - c.lane.xEnd) * c.lane.dir > 0);
    if (gone.length) {
      for (const c of gone) this.group.remove(c.mesh);
      this.cars = this.cars.filter((c) => !gone.includes(c));
    }

    this.updateLights();
  }

  private spawn(lane: CarLaneDef) {
    const colors = [0xf4f1ea, 0xd8d9db, 0x3a3f47, 0xb8332b, 0x2f5d8a, 0xe7c45a, 0x6d8b74];
    const car = new Car(lane, lane.xStart, colors[Math.floor(Math.random() * colors.length)]);
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

  /** 子どもがこの車道へ渡り始めてよいか */
  mayCross(road: CarRoad, x: number): boolean {
    if (road.signal) return this.signal.ped === 'green';
    return !this.cars.some((c) => {
      if (!road.lanes.includes(c.lane)) return false;
      const ahead = (x - c.x) * c.lane.dir;
      return ahead > -CAR_LEN && ahead < 24;
    });
  }

  /** 石に近づいている車の方向を路面の矢印で知らせ、近さ（0..1）を返す */
  updateWarnings(stoneX: number, stoneZ: number): number {
    let nearest = 0;
    for (const w of this.warnings) {
      const lane = w.lane;
      let best = Infinity;
      if (Math.abs(stoneZ - lane.z) < 9) {
        for (const c of this.cars) {
          if (c.lane !== lane || c.speed < 0.6) continue;
          const d = (stoneX - c.front) * lane.dir;
          if (d > 0 && d < best) best = d;
        }
      }
      const show = best < 40;
      w.mesh.visible = show;
      if (show) {
        const lead = Math.min(best, 5.5);
        w.mesh.position.set(stoneX - lane.dir * lead, 0.02, lane.z);
        (w.mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.45 * Math.abs(Math.sin(this.time * (best < 15 ? 9 : 4)));
        nearest = Math.max(nearest, 1 - best / 40);
      }
    }
    return nearest;
  }

  private updateLights() {
    const car = this.signal.car;
    const ped = this.signal.ped;
    for (const head of this.lights.car) {
      for (const k of ['green', 'yellow', 'red'] as const) head[k].color.setHex(k === car ? LIT[k] : DIM);
    }
    const blinkOn = ped === 'green' || (ped === 'blink' && Math.floor(this.signal.t * 3) % 2 === 0);
    for (const head of this.lights.ped) {
      head.green.color.setHex(blinkOn ? LIT.green : DIM);
      head.red.color.setHex(ped === 'red' ? LIT.red : DIM);
    }
  }
}

const LIT = { green: 0x35d4a0, yellow: 0xffb52e, red: 0xff4a3a };
const DIM = 0x2c2f33;

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

function buildCarMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(CAR_HALF_W * 2, 0.7, CAR_LEN), lambert(color));
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR_HALF_W * 2 - 0.15, 0.55, 2.0), lambert(0x3d4a57));
  cabin.position.set(0, 1.17, -0.25);
  cabin.castShadow = true;
  g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(CAR_HALF_W * 2 - 0.2, 0.06, 1.8), lambert(color));
  roof.position.set(0, 1.47, -0.3);
  g.add(roof);
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = lambert(0x222222);
  for (const [x, z] of [[-0.8, 1.2], [0.8, 1.2], [-0.8, -1.2], [0.8, -1.2]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, 0.3, z);
    g.add(w);
  }
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2c4 });
  for (const x of [-0.55, 0.55]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.05), lampMat);
    lamp.position.set(x, 0.65, CAR_LEN / 2 + 0.01);
    g.add(lamp);
  }
  return g;
}

/** 大通りの交差点に車用・歩行者用の信号機を立てる */
function buildSignals(group: THREE.Group) {
  const poleMat = lambert(0x8e8a84);
  const housingMat = lambert(0x5d6066);
  const car: Record<CarLight, THREE.MeshBasicMaterial>[] = [];
  const ped: Record<'red' | 'green', THREE.MeshBasicMaterial>[] = [];
  const lampGeo = new THREE.CircleGeometry(0.11, 12);

  const pole = (x: number, z: number, h: number) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, h, 8), poleMat);
    p.position.set(x, h / 2, z);
    p.castShadow = true;
    group.add(p);
  };

  // 車用：交差点の手前の角から車線の上へ張り出す。facing は信号の正面が向く方向
  const carHead = (x: number, z: number, facing: number, poleZ: number) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, Math.abs(z - poleZ)), poleMat);
    arm.position.set(x, 4.5, (z + poleZ) / 2);
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
    head.position.set(x, 4.3, z);
    head.rotation.y = facing;
    group.add(head);
    car.push(mats);
  };

  const pedHead = (x: number, z: number, facing: number) => {
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
    head.position.set(x, 2.5, z);
    head.rotation.y = facing;
    group.add(head);
    ped.push({ red, green });
  };

  const z0 = MAIN_ROAD.z0;
  const z1 = MAIN_ROAD.z1;
  // +X へ走る車線（手前側）用：西の角
  pole(-3.7, z0 - 0.4, 4.6);
  carHead(-3.7, z0 + 1.6, -Math.PI / 2, z0 - 0.4);
  // -X へ走る車線（奥側）用：東の角
  pole(3.7, z1 + 0.4, 4.6);
  carHead(3.7, z1 - 1.6, Math.PI / 2, z1 + 0.4);
  // 歩行者用：渡る先（奥）に、こちら向き。帰りに見る手前側も
  pole(2.6, z1 + 0.35, 3);
  pedHead(2.6, z1 + 0.35, Math.PI);
  pole(-2.9, z0 - 0.4, 3);
  pedHead(-2.9, z0 - 0.4, 0);
  return { car, ped };
}
