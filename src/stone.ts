import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { CURB_HEIGHT, CURBS, groundAt, POLES, WALLS, type Rect } from './level';

const G = 9.8;
/** スピンによる横方向加速度の最大値 [m/s²] */
const CURVE_ACCEL = 3.2;

/** 石の性格。数値は画面に出さず、見た目と動きから伝える。 */
export interface StoneTraits {
  radius: number;
  mass: number;
  /** 0..1 丸いほど転がりやすく、揺れにくい */
  roundness: number;
  /** 0..1 路面への食いつき。スピンの効き */
  grip: number;
  restitution: number;
  /** 0..1 重心の偏り。予測しにくい揺れ */
  eccentricity: number;
}

export function randomTraits(rand: () => number): StoneTraits {
  const roundness = 0.25 + rand() * 0.7;
  return {
    radius: 0.09 + rand() * 0.05,
    mass: 0.75 + rand() * 0.55,
    roundness,
    grip: 0.5 + rand() * 0.5,
    restitution: 0.3 + rand() * 0.3,
    eccentricity: (1 - roundness) * (0.4 + rand() * 0.6),
  };
}

export interface StoneEvents {
  /** 塀・電柱・地面にぶつかった。strength は 0..1 程度 */
  onImpact?: (strength: number) => void;
}

export class Stone {
  readonly mesh: THREE.Mesh;
  readonly traits: StoneTraits;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  spin = 0;
  moving = false;
  /** 回収不能になった後の演出状態 */
  lost: null | 'falling' | 'sinking' | 'flying' = null;

  private rollPhase = 0;
  private wobbleOffset: number;
  private stillTime = 0;
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly lostTarget = new THREE.Vector3();

  constructor(seed: number, private readonly events: StoneEvents = {}) {
    const rand = createRng(seed);
    this.traits = randomTraits(rand);
    this.wobbleOffset = rand() * Math.PI * 2;
    this.mesh = new THREE.Mesh(makeStoneGeometry(this.traits, rand), new THREE.MeshLambertMaterial({ color: stoneColor(rand), flatShading: true }));
    this.mesh.castShadow = true;
    this.mesh.rotation.set(rand() * 6, rand() * 6, rand() * 6);
  }

  place(x: number, z: number) {
    this.position.set(x, groundAt(x, z) + this.traits.radius, z);
    this.velocity.set(0, 0, 0);
    this.spin = 0;
    this.moving = false;
    this.syncMesh();
  }

  /**
   * @param angle キック方向（+Z を 0、+X 側が正）
   * @param power 0..1（オーバーチャージ時は 1 を少し超える）
   * @param spin -1..1 正で右（蹴る人から見て）に曲がる
   */
  kick(angle: number, power: number, spin: number) {
    const t = this.traits;
    const speed = (0.6 + 6.6 * Math.pow(power, 1.4)) / Math.sqrt(t.mass);
    this.velocity.set(Math.sin(angle) * speed, power > 0.6 ? (power - 0.6) * 6 : 0, Math.cos(angle) * speed);
    this.spin = spin;
    this.moving = true;
    this.stillTime = 0;
  }

  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** 石の中心が地面に接するときの高さ */
  get floor() {
    return groundAt(this.position.x, this.position.z) + this.traits.radius;
  }

  /** 地面に接しているか（バウンド中は false） */
  get onGround() {
    return this.position.y <= this.floor + 0.02 && this.velocity.y <= 0;
  }

  /**
   * @param obstacles 止まっている車など、跳ね返る箱
   */
  step(dt: number, obstacles: Rect[] = []) {
    if (this.lost) {
      this.updateLost(dt);
      return;
    }
    if (!this.moving) return;
    // 速いときは分割して塀のすり抜けを防ぐ
    const travel = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z) * dt;
    const n = Math.min(8, Math.max(1, Math.ceil(travel / (this.traits.radius * 0.5))));
    for (let i = 0; i < n; i++) this.integrate(dt / n, obstacles);
    this.syncMesh();
  }

  private integrate(dt: number, obstacles: Rect[]) {
    if (!this.moving) return;
    const t = this.traits;
    const p = this.position;
    const v = this.velocity;

    // 縦方向：浮いているか縦の速度が残っていれば重力、着地でバウンド。
    // 接地の判定に誤差の幅を持たせると「浮いても接地してもいない」状態で
    // 摩擦がかからず転がり続けるので、着地したら必ず y と v.y を揃える。
    const floor = this.floor;
    // 切り下げから歩道へ上がったときは段差の上に乗せる
    if (p.y < floor) p.y = floor;
    const airborne = p.y > floor || v.y !== 0;
    if (airborne) {
      v.y -= G * dt;
      p.y += v.y * dt;
      if (p.y <= floor) {
        p.y = floor;
        if (-v.y > 0.9) {
          this.events.onImpact?.(Math.min(1, -v.y / 5));
          v.y = -v.y * t.restitution * 0.6;
          v.x *= 0.82;
          v.z *= 0.82;
        } else {
          v.y = 0;
        }
      }
    }
    const grounded = p.y <= floor && v.y === 0;

    let speed = Math.hypot(v.x, v.z);
    if (speed > 1e-4) {
      const dx = v.x / speed;
      const dz = v.z / speed;
      // 進行方向の右手ベクトル
      const rx = -dz;
      const rz = dx;

      // スピンによるカーブ。接地中によく効き、速すぎ・遅すぎでは弱い
      const curveScale = (grounded ? 1 : 0.3) * t.grip * Math.min(speed, 5) / 5;
      let lateral = CURVE_ACCEL * this.spin * curveScale;

      // 偏心による揺れ。転がる位相に合わせて左右に振れる
      if (grounded) {
        lateral += t.eccentricity * 1.4 * Math.sin(this.rollPhase * 0.5 + this.wobbleOffset) * Math.min(speed, 3);
      }
      v.x += rx * lateral * dt;
      v.z += rz * lateral * dt;

      if (grounded) {
        const rollDecel = (4.0 - 2.0 * t.roundness) * (1 + 0.04 * speed);
        speed = Math.hypot(v.x, v.z);
        const next = Math.max(0, speed - rollDecel * dt);
        v.x *= next / speed;
        v.z *= next / speed;
        speed = next;
      }

      p.x += v.x * dt;
      p.z += v.z * dt;
      this.roll(speed * dt);
    }

    this.spin *= Math.exp(-(grounded ? 0.9 : 0.2) * dt);
    this.collide(obstacles);

    if (grounded && Math.hypot(v.x, v.z) < 0.05) {
      this.stillTime += dt;
      if (this.stillTime > 0.2) {
        v.set(0, 0, 0);
        this.spin = 0;
        this.moving = false;
      }
    } else {
      this.stillTime = 0;
    }
  }

  /** 見た目の転がり */
  private roll(distance: number) {
    const v = this.velocity;
    if (Math.hypot(v.x, v.z) < 1e-4) return;
    const angle = distance / this.traits.radius;
    this.rollPhase += angle;
    this.tmpAxis.set(v.z, 0, -v.x).normalize();
    this.tmpQuat.setFromAxisAngle(this.tmpAxis, angle);
    this.mesh.quaternion.premultiply(this.tmpQuat);
  }

  private collide(obstacles: Rect[]) {
    const r = this.traits.radius;
    const p = this.position;

    for (const w of WALLS) {
      // 線分上の最近点
      const sx = w.x2 - w.x1;
      const sz = w.z2 - w.z1;
      const tt = Math.max(0, Math.min(1, ((p.x - w.x1) * sx + (p.z - w.z1) * sz) / (sx * sx + sz * sz)));
      this.pushOut(w.x1 + sx * tt, w.z1 + sz * tt, r);
    }
    for (const pole of POLES) this.pushOut(pole.x, pole.z, r + pole.radius);
    // 縁石：車道側にいて、石の底が縁石の上面より低いときだけ跳ね返る
    if (p.y - r < CURB_HEIGHT - 0.02) {
      for (const c of CURBS) {
        const sx = c.x2 - c.x1;
        const sz = c.z2 - c.z1;
        const tt = ((p.x - c.x1) * sx + (p.z - c.z1) * sz) / (sx * sx + sz * sz);
        if (tt < 0 || tt > 1) continue;
        const side = (p.x - c.x1) * c.nx + (p.z - c.z1) * c.nz;
        if (side < 0 || side >= r) continue;
        this.pushOut(p.x - side * c.nx, p.z - side * c.nz, r);
      }
    }
    if (p.y < 0.8) {
      for (const o of obstacles) {
        this.pushOut(Math.max(o.x0, Math.min(o.x1, p.x)), Math.max(o.z0, Math.min(o.z1, p.z)), r);
      }
    }
  }

  /** 点 (cx, cz) から minDist 以内なら押し出して反射する */
  private pushOut(cx: number, cz: number, minDist: number) {
    const p = this.position;
    const v = this.velocity;
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minDist * minDist) return;
    const d = Math.sqrt(d2) || 1e-6;
    const nx = dx / d;
    const nz = dz / d;
    p.x = cx + nx * minDist;
    p.z = cz + nz * minDist;
    const vn = v.x * nx + v.z * nz;
    if (vn < 0) {
      const e = this.traits.restitution;
      this.events.onImpact?.(Math.min(1, -vn / 6));
      this.spin *= -0.4;
      v.x -= (1 + e) * vn * nx;
      v.z -= (1 + e) * vn * nz;
      // 塀と擦れて接線方向も少し落ちる
      v.x *= 0.92;
      v.z *= 0.92;
    }
  }

  // ---------- 失う演出 ----------

  /** 側溝へ落ちる。rect は側溝の開口部 */
  fallInto(gutter: Rect) {
    this.lost = 'falling';
    this.moving = false;
    this.lostTarget.set(
      Math.max(gutter.x0 + 0.1, Math.min(gutter.x1 - 0.1, this.position.x)),
      0,
      Math.max(gutter.z0 + 0.1, Math.min(gutter.z1 - 0.1, this.position.z)),
    );
    this.velocity.y = 0;
  }

  /** 草むらに分け入って見えなくなる */
  sink() {
    this.lost = 'sinking';
    this.moving = false;
  }

  /** 車にはじかれて飛んでいく */
  launch(vx: number, vy: number, vz: number) {
    this.lost = 'flying';
    this.moving = false;
    this.velocity.set(vx, vy, vz);
    this.position.y = Math.max(this.position.y, this.floor + 0.05);
  }

  private updateLost(dt: number) {
    const p = this.position;
    const v = this.velocity;
    const r = this.traits.radius;
    switch (this.lost) {
      case 'falling': {
        // 縁から溝の中へ転がり込み、沈む
        p.x += (this.lostTarget.x - p.x) * Math.min(1, dt * 10);
        p.z += (this.lostTarget.z - p.z) * Math.min(1, dt * 10);
        v.y -= G * dt;
        p.y += v.y * dt;
        this.roll(Math.abs(v.y) * dt * 0.5);
        if (p.y < -0.4) this.mesh.visible = false;
        break;
      }
      case 'sinking': {
        const k = Math.exp(-6 * dt);
        v.x *= k;
        v.z *= k;
        p.x += v.x * dt;
        p.z += v.z * dt;
        p.y = Math.max(r - 0.3, p.y - dt * 0.15);
        break;
      }
      case 'flying': {
        v.y -= G * dt;
        p.addScaledVector(v, dt);
        if (p.y < this.floor) {
          p.y = this.floor;
          v.y = Math.abs(v.y) * 0.4;
          v.x *= 0.7;
          v.z *= 0.7;
        }
        this.roll(Math.hypot(v.x, v.z) * dt);
        break;
      }
    }
    this.syncMesh();
  }

  private syncMesh() {
    // いびつな石ほど転がりながらコトコト上下する
    const bob = this.moving ? this.traits.eccentricity * 0.025 * Math.abs(Math.sin(this.rollPhase)) : 0;
    this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
  }
}

function makeStoneGeometry(t: StoneTraits, rand: () => number): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);

  // 丸くない石ほど扁平・細長く、表面の凸凹も大きい
  const flat = 1 - (1 - t.roundness) * 0.45;
  const long = 1 + (1 - t.roundness) * 0.35;
  const bumps = 0.04 + (1 - t.roundness) * 0.14;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = 1 + (rand() * 2 - 1) * bumps;
    v.multiplyScalar(n);
    v.set(v.x * long, v.y * flat, v.z);
    // 偏心：片側だけ少し膨らませる
    if (v.x > 0) v.x *= 1 + t.eccentricity * 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.scale(t.radius, t.radius, t.radius);
  geo.computeVertexNormals();
  return geo;
}

function stoneColor(rand: () => number): THREE.Color {
  const palettes = [0x9c9286, 0x8b8a86, 0xa89a84, 0x7f7a74, 0xb3a996, 0x8f8070];
  const c = new THREE.Color(palettes[Math.floor(rand() * palettes.length)]);
  c.offsetHSL(0, 0, (rand() - 0.5) * 0.08);
  return c;
}
