import * as THREE from 'three';
import { createRng, damp } from './rng';

const lambert = (color: number | THREE.Color) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** 足元の石までの距離（キック位置） */
export const KICK_OFFSET = 0.42;

type Pose = 'idle' | 'walk' | 'run' | 'windup' | 'kick';

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
  private pose: Pose = 'idle';
  private cycle = 0;
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

  /** 目標地点へ移動。到着したら true */
  moveToward(target: THREE.Vector3, speed: number, dt: number): boolean {
    const p = this.root.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.02) {
      p.x = target.x;
      p.z = target.z;
      return true;
    }
    const step = Math.min(d, speed * dt);
    p.x += (dx / d) * step;
    p.z += (dz / d) * step;
    if (d > 0.15) this.turnTo(Math.atan2(dx, dz), dt, 10);
    return false;
  }

  turnTo(angle: number, dt: number, rate = 8) {
    let diff = angle - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.heading += diff * damp(rate, dt);
  }

  update(dt: number) {
    this.root.rotation.y = this.heading;
    let legL = 0;
    let legR = 0;
    let bob = 0;
    let lean = 0;
    switch (this.pose) {
      case 'walk':
      case 'run': {
        const run = this.pose === 'run';
        this.cycle += dt * (run ? 13 : 8);
        const amp = run ? 0.75 : 0.45;
        legL = Math.sin(this.cycle) * amp;
        legR = -legL;
        bob = Math.abs(Math.cos(this.cycle)) * (run ? 0.05 : 0.025);
        lean = run ? 0.15 : 0.04;
        break;
      }
      case 'windup':
        // 右足を後ろへ引く
        legR = -0.3 - this.windup * 0.9;
        legL = 0.05;
        lean = -0.05 - this.windup * 0.08;
        break;
      case 'kick': {
        this.kickT += dt;
        const k = Math.min(1, this.kickT / 0.12);
        const back = -0.3 - this.windup * 0.9;
        legR = back + (1.1 + this.windup * 0.4 - back) * easeOut(k);
        legL = 0.05;
        lean = 0.08;
        if (this.kickT > 0.45) this.pose = 'idle';
        break;
      }
      default:
        this.cycle = 0;
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
