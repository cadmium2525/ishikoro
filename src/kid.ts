import * as THREE from 'three';
import { createRng, damp } from './rng';

const lambert = (color: number | THREE.Color) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** 足元の石までの距離（キック位置） */
export const KICK_OFFSET = 0.42;

/** move：速度に合わせて立つ・歩く・走るを自動で切り替える */
type Pose = 'move' | 'windup' | 'kick';

const ACCEL = 7;
const DECEL = 10;

/** 仮の主人公。ランドセルを背負った小学生のローポリモデル。 */
export class Kid {
  readonly root = new THREE.Group();
  /** 向き（+Z を 0 とするヨー角） */
  heading = 0;

  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly body = new THREE.Group();
  private pose: Pose = 'move';
  private cycle = 0;
  /** 実際の移動速度。目標速度へなめらかに近づける */
  private speed = 0;
  private movedThisFrame = false;
  private windup = 0;
  private kickT = 0;
  /** 首を軸に頭を傾ける（中の頭の部品は体の座標のまま置く） */
  private readonly neck = new THREE.Group();
  private readonly headParts = new THREE.Group();
  private mood: 'none' | 'look' | 'sad' = 'none';
  private nod = 0;

  constructor(seed: number) {
    const rand = createRng(seed);
    const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
    const skin = lambert(pick([0xf1c9a5, 0xe8b890, 0xd9a37a, 0xf5d5b8]));
    const shirt = lambert(pick([0xf2f0e8, 0x9cc3d9, 0xf0c36b, 0xe39b8f, 0xa6c48a, 0xd8c3e6, 0xf4a259, 0x7fb3a8]));
    const pantsColor = pick([0x3c4a63, 0x5b4b3a, 0x2f3a2f, 0x6b6f78, 0x8a3b3b]);
    const pants = lambert(pantsColor);
    const shoes = lambert(pick([0xf4f1ea, 0x5a6fa8, 0xe07a5f, 0x4a4a4a]));
    const socks = lambert(0xf8f6f0);
    const hair = lambert(pick([0x2b211b, 0x3a2a1e, 0x5a3b25, 0x1f1a17]));
    const bottoms = pick(['long', 'shorts', 'shorts', 'skirt'] as const);
    const hairStyle = pick(['short', 'short', 'bob', 'pony', 'twin'] as const);
    const hat = rand() < 0.45 ? pick(['yellow', 'redwhite'] as const) : null;
    const scale = 0.88 + rand() * 0.22;

    this.root.add(this.body);
    this.body.scale.setScalar(scale);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // 脚（股関節を原点にして回す）。長ズボン・半ズボン・スカート
    for (const [hip, x] of [[this.hipL, 0.09], [this.hipR, -0.09]] as const) {
      hip.position.set(x, 0.55, 0);
      if (bottoms === 'long') {
        add(hip, new THREE.BoxGeometry(0.11, 0.5, 0.12), pants, 0, -0.25, 0);
      } else {
        if (bottoms === 'shorts') add(hip, new THREE.BoxGeometry(0.12, 0.2, 0.13), pants, 0, -0.1, 0);
        add(hip, new THREE.BoxGeometry(0.09, bottoms === 'shorts' ? 0.3 : 0.5, 0.1), skin, 0, bottoms === 'shorts' ? -0.35 : -0.25, 0);
        add(hip, new THREE.BoxGeometry(0.1, 0.1, 0.11), socks, 0, -0.44, 0);
      }
      add(hip, new THREE.BoxGeometry(0.12, 0.07, 0.2), shoes, 0, -0.515, 0.04);
      this.body.add(hip);
    }
    if (bottoms === 'skirt') add(this.body, new THREE.CylinderGeometry(0.17, 0.25, 0.24, 8), pants, 0, 0.5, 0);

    add(this.body, new THREE.BoxGeometry(0.34, 0.42, 0.2), shirt, 0, 0.76, 0);
    this.neck.position.y = 0.97;
    this.headParts.position.y = -0.97;
    this.neck.add(this.headParts);
    this.body.add(this.neck);
    add(this.headParts, new THREE.IcosahedronGeometry(0.16, 1), skin, 0, 1.13, 0);

    // 髪型
    const cap = add(this.headParts, new THREE.SphereGeometry(0.168, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 1.15, 0);
    cap.rotation.x = -0.25;
    if (hairStyle === 'bob') add(this.headParts, new THREE.BoxGeometry(0.36, 0.2, 0.26), hair, 0, 1.07, -0.04);
    if (hairStyle === 'pony') {
      const tail = add(this.headParts, new THREE.CylinderGeometry(0.05, 0.03, 0.22, 6), hair, 0, 1.08, -0.18);
      tail.rotation.x = 0.5;
    }
    if (hairStyle === 'twin') for (const sx of [-1, 1]) add(this.headParts, new THREE.IcosahedronGeometry(0.06, 0), hair, sx * 0.17, 1.06, -0.05);

    // 通学帽（黄色い帽子か紅白帽）
    if (hat) {
      const hatMat = lambert(hat === 'yellow' ? 0xf2c230 : 0xd8433a);
      add(this.headParts, new THREE.SphereGeometry(0.175, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), hatMat, 0, 1.17, 0);
      if (hat === 'yellow') add(this.headParts, new THREE.CylinderGeometry(0.24, 0.24, 0.02, 12), hatMat, 0, 1.17, 0, false);
      else add(this.headParts, new THREE.BoxGeometry(0.2, 0.02, 0.1), hatMat, 0, 1.17, 0.17, false);
    }

    // ランドセル（1年生は黄色いカバー）
    add(this.body, new THREE.BoxGeometry(0.32, 0.36, 0.18), lambert(pick([0xb3362c, 0x2d3a55, 0x6b3f2a, 0xd77ca0, 0x3f6e5a, 0x6a4c8a, 0x88a9c9, 0x3a3a3a, 0xc96a2c])), 0, 0.8, -0.19);
    if (rand() < 0.25) add(this.body, new THREE.BoxGeometry(0.33, 0.22, 0.02), lambert(0xf2d43a), 0, 0.88, -0.285, false);

    for (const [arm, x] of [[this.armL, 0.21], [this.armR, -0.21]] as const) {
      arm.position.set(x, 0.95, 0);
      add(arm, new THREE.BoxGeometry(0.08, 0.38, 0.09), shirt, 0, -0.19, 0);
      add(arm, new THREE.BoxGeometry(0.07, 0.07, 0.07), skin, 0, -0.41, 0, false);
      this.body.add(arm);
    }
  }

  /** 片付け：主人公の形と材質を捨てる */
  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }

  /** 家に着いたら足元の石を見下ろす（look）、失敗したらうなだれる（sad） */
  setMood(m: 'none' | 'look' | 'sad') {
    this.mood = m;
  }

  /** 今の歩く速さ [m/s]（足音用） */
  get moveSpeed() {
    return this.speed;
  }

  get position() {
    return this.root.position;
  }

  setPose(pose: Pose) {
    if (pose === 'kick' && this.pose !== 'kick') this.kickT = 0;
    this.pose = pose;
  }

  /** 構え中の足の引き具合 0..1 */
  setWindup(amount: number) {
    this.windup = amount;
  }

  /** 目標地点へ移動。到着したら true。近づくほど減速して止まる */
  moveToward(target: THREE.Vector3, maxSpeed: number, dt: number): boolean {
    const p = this.root.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.02) {
      p.x = target.x;
      p.z = target.z;
      return true;
    }
    const desired = Math.min(maxSpeed, 0.5 + d * 2.5);
    this.speed = desired > this.speed ? Math.min(desired, this.speed + ACCEL * dt) : Math.max(desired, this.speed - DECEL * dt);
    const step = Math.min(d, this.speed * dt);
    p.x += (dx / d) * step;
    p.z += (dz / d) * step;
    if (d > 0.15) this.turnTo(Math.atan2(dx, dz), dt, 10);
    this.movedThisFrame = true;
    return false;
  }

  turnTo(angle: number, dt: number, rate = 8) {
    let diff = angle - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.heading += diff * damp(rate, dt);
  }

  update(dt: number) {
    if (!this.movedThisFrame) this.speed = Math.max(0, this.speed - DECEL * dt);
    this.movedThisFrame = false;
    this.root.rotation.y = this.heading;
    let legL = 0;
    let legR = 0;
    let bob = 0;
    let lean = 0;
    switch (this.pose) {
      case 'move': {
        // 歩幅・ピッチ・前傾を速度から連続的に決める（姿勢の切り替えでカクつかない）
        const run = Math.min(1, this.speed / 4.2);
        const gait = Math.min(1, this.speed / 0.6);
        this.cycle += dt * (5 + this.speed * 2);
        const amp = (0.25 + 0.5 * run) * gait;
        legL = Math.sin(this.cycle) * amp;
        legR = -legL;
        bob = Math.abs(Math.cos(this.cycle)) * (0.02 + 0.03 * run) * gait;
        lean = 0.02 * gait + 0.13 * run;
        break;
      }
      case 'windup':
        // 左足を後ろへ引く
        legL = -0.3 - this.windup * 0.9;
        legR = 0.05;
        lean = -0.05 - this.windup * 0.08;
        break;
      case 'kick': {
        this.kickT += dt;
        const k = Math.min(1, this.kickT / 0.12);
        const back = -0.3 - this.windup * 0.9;
        legL = back + (1.1 + this.windup * 0.4 - back) * easeOut(k);
        legR = 0.05;
        lean = 0.08;
        if (this.kickT > 0.45) this.pose = 'move';
        break;
      }
    }
    // 回転軸の符号：負で後ろ、正で前
    this.hipL.rotation.x = -legL;
    this.hipR.rotation.x = -legR;
    this.armL.rotation.x = -legR * 0.8;
    this.armR.rotation.x = -legL * 0.8;
    // 気持ち：見下ろす・うなだれる
    const nodTarget = this.mood === 'look' ? 0.55 : this.mood === 'sad' ? 0.45 : 0;
    this.nod += (nodTarget - this.nod) * damp(4, dt);
    this.neck.rotation.x = this.nod;
    if (this.mood === 'sad' && this.pose === 'move') {
      this.armL.rotation.x *= 0.3;
      this.armR.rotation.x *= 0.3;
      lean -= 0.06;
    }
    this.body.position.y = bob;
    this.body.rotation.x = lean;
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
