import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { WALL_X, START_WALL_Z, ROAD_LENGTH, type PoleCollider } from './world';

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

  private rollPhase = 0;
  private wobbleOffset: number;
  private stillTime = 0;
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(seed: number, private readonly events: StoneEvents = {}) {
    const rand = createRng(seed);
    this.traits = randomTraits(rand);
    this.wobbleOffset = rand() * Math.PI * 2;
    this.mesh = new THREE.Mesh(makeStoneGeometry(this.traits, rand), new THREE.MeshLambertMaterial({ color: stoneColor(rand), flatShading: true }));
    this.mesh.castShadow = true;
    this.mesh.rotation.set(rand() * 6, rand() * 6, rand() * 6);
  }

  place(x: number, z: number) {
    this.position.set(x, this.traits.radius, z);
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

  step(dt: number, poles: PoleCollider[]) {
    if (!this.moving) return;
    const t = this.traits;
    const p = this.position;
    const v = this.velocity;

    // 縦方向：浮いていれば重力、着地でバウンド
    const airborne = p.y > t.radius + 1e-4 || v.y > 0;
    if (airborne) {
      v.y -= G * dt;
      p.y += v.y * dt;
      if (p.y <= t.radius) {
        p.y = t.radius;
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
    const grounded = p.y <= t.radius + 1e-4 && v.y === 0;

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

      // 見た目の転がり
      const roll = (speed * dt) / t.radius;
      this.rollPhase += roll;
      this.tmpAxis.set(v.z, 0, -v.x).normalize();
      this.tmpQuat.setFromAxisAngle(this.tmpAxis, roll);
      this.mesh.quaternion.premultiply(this.tmpQuat);
    }

    this.spin *= Math.exp(-(grounded ? 0.9 : 0.2) * dt);
    this.collide(poles);

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
    this.syncMesh();
  }

  private collide(poles: PoleCollider[]) {
    const t = this.traits;
    const p = this.position;
    const v = this.velocity;
    const e = t.restitution;

    const hitWall = (normalSpeed: number) => {
      this.events.onImpact?.(Math.min(1, Math.abs(normalSpeed) / 6));
      this.spin *= -0.4;
    };
    const maxX = WALL_X - t.radius;
    if (p.x > maxX && v.x > 0) { p.x = maxX; hitWall(v.x); v.x = -v.x * e; v.z *= 0.9; }
    if (p.x < -maxX && v.x < 0) { p.x = -maxX; hitWall(v.x); v.x = -v.x * e; v.z *= 0.9; }
    const minZ = START_WALL_Z + t.radius;
    const maxZ = ROAD_LENGTH + 2 - 0.075 - t.radius;
    if (p.z < minZ && v.z < 0) { p.z = minZ; hitWall(v.z); v.z = -v.z * e; v.x *= 0.9; }
    if (p.z > maxZ && v.z > 0) { p.z = maxZ; hitWall(v.z); v.z = -v.z * e; v.x *= 0.9; }

    for (const pole of poles) {
      const dx = p.x - pole.x;
      const dz = p.z - pole.z;
      const minDist = pole.radius + t.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d;
      const nz = dz / d;
      p.x = pole.x + nx * minDist;
      p.z = pole.z + nz * minDist;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) {
        hitWall(vn);
        v.x -= (1 + e) * vn * nx;
        v.z -= (1 + e) * vn * nz;
      }
    }
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
