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

  constructor(seed: number) {
    const rand = createRng(seed);
    const shirtColors = [0xf2f0e8, 0x9cc3d9, 0xf0c36b, 0xe39b8f, 0xa6c48a];
    const randoseruColors = [0xb3362c, 0x2d3a55, 0x6b3f2a, 0xd77ca0, 0x3f6e5a];
    const skin = lambert(0xf1c9a5);
    const shirt = lambert(shirtColors[Math.floor(rand() * shirtColors.length)]);
    const pants = lambert(0x3c4a63);
    const shoes = lambert(0xf4f1ea);
    const hair = lambert(0x2b211b);
    const scale = 0.92 + rand() * 0.16;

    this.root.add(this.body);
    this.body.scale.setScalar(scale);

    // 脚（股関節を原点にして回す）
    for (const [hip, x] of [[this.hipL, 0.09], [this.hipR, -0.09]] as const) {
      hip.position.set(x, 0.55, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.5, 0.12), pants);
      leg.position.y = -0.25;
      leg.castShadow = true;
      hip.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.2), shoes);
      shoe.position.set(0, -0.515, 0.04);
      shoe.castShadow = true;
      hip.add(shoe);
      this.body.add(hip);
    }

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.2), shirt);
    torso.position.y = 0.76;
    torso.castShadow = true;
    this.body.add(torso);

    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), skin);
    head.position.y = 1.13;
    head.castShadow = true;
    this.body.add(head);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.168, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    hairCap.position.y = 1.15;
    hairCap.rotation.x = -0.25;
    this.body.add(hairCap);

    // ランドセル
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.36, 0.18), lambert(randoseruColors[Math.floor(rand() * randoseruColors.length)]));
    bag.position.set(0, 0.8, -0.19);
    bag.castShadow = true;
    this.body.add(bag);

    for (const [arm, x] of [[this.armL, 0.21], [this.armR, -0.21]] as const) {
      arm.position.set(x, 0.95, 0);
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.38, 0.09), shirt);
      a.position.y = -0.19;
      a.castShadow = true;
      arm.add(a);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), skin);
      hand.position.y = -0.41;
      arm.add(hand);
      this.body.add(arm);
    }
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
    this.body.position.y = bob;
    this.body.rotation.x = lean;
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
