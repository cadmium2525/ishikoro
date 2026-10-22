import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng } from './rng';
import { CURB_HEIGHT, type Level, type Rect } from './level';

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

type Range = [number, number];
type Shape = 'rock' | 'smooth' | 'flat' | 'gravel' | 'brick' | 'heart' | 'crystal' | 'disc';
type Pattern = 'plain' | 'speckle' | 'band' | 'spiral' | 'pores';

/** 石の種類。見た目（形・色・模様）と性格の幅を決める */
export interface StoneKind {
  id: string;
  /** 呼び名の名詞部分 */
  noun: string;
  /** 出やすさ（相対値） */
  weight: number;
  rare: boolean;
  radius: Range;
  mass: Range;
  roundness: Range;
  grip: Range;
  restitution: Range;
  /** 偏心 = (1 - roundness) × この幅 */
  ecc: Range;
  shape: Shape;
  colors: number[];
  pattern: Pattern;
  /** 模様の色 */
  accent?: number[];
  glow?: number;
}

const kind = (k: Omit<StoneKind, 'rare' | 'pattern'> & Partial<Pick<StoneKind, 'rare' | 'pattern'>>): StoneKind =>
  ({ rare: false, pattern: 'plain', ...k });

export const STONE_KINDS: StoneKind[] = [
  // ふつうの石：これまでの石。性格の幅がいちばん広い
  kind({ id: 'plain', noun: 'いし', weight: 30, radius: [0.09, 0.14], mass: [0.75, 1.3], roundness: [0.25, 0.95], grip: [0.5, 1], restitution: [0.3, 0.6], ecc: [0.4, 1], shape: 'rock', colors: [0x9c9286, 0x8b8a86, 0xa89a84, 0x7f7a74, 0xb3a996, 0x8f8070] }),
  // 川原の石：つるんと丸く、よく転がる
  kind({ id: 'river', noun: 'かわらいし', weight: 14, radius: [0.09, 0.13], mass: [0.85, 1.2], roundness: [0.85, 0.97], grip: [0.4, 0.7], restitution: [0.3, 0.45], ecc: [0.2, 0.5], shape: 'smooth', colors: [0xa7a39b, 0x8e8c88, 0xb5aa98, 0x9a948a] }),
  // 平たい石：ぺったんこで、ふらつきながらすぐ止まる
  kind({ id: 'flat', noun: 'ひらたい いし', weight: 12, radius: [0.1, 0.14], mass: [0.8, 1.15], roundness: [0.2, 0.35], grip: [0.6, 1], restitution: [0.2, 0.35], ecc: [0.6, 1], shape: 'flat', colors: [0x8f8b84, 0x9d9488, 0x7d7a76] }),
  // 砕石：角ばっていて、跳ね方が読めない
  kind({ id: 'gravel', noun: 'とがった じゃり', weight: 12, radius: [0.08, 0.11], mass: [0.75, 1.0], roundness: [0.2, 0.4], grip: [0.6, 1], restitution: [0.5, 0.65], ecc: [0.6, 1], shape: 'gravel', colors: [0x8a8784, 0x9b958c, 0x76736f] }),
  kind({ id: 'white', noun: 'しろい いし', weight: 8, radius: [0.09, 0.13], mass: [0.8, 1.15], roundness: [0.5, 0.9], grip: [0.5, 0.9], restitution: [0.35, 0.55], ecc: [0.3, 0.8], shape: 'rock', colors: [0xeeeae2, 0xe6e1d6, 0xf3efe8] }),
  // 黒い石：ずっしり重く、回転が効きにくくまっすぐ転がる
  kind({ id: 'black', noun: 'くろい いし', weight: 8, radius: [0.1, 0.13], mass: [1.2, 1.45], roundness: [0.6, 0.9], grip: [0.3, 0.5], restitution: [0.25, 0.4], ecc: [0.1, 0.4], shape: 'rock', colors: [0x3d3b3a, 0x46423f, 0x34322f] }),
  kind({ id: 'speckle', noun: 'ごましお いし', weight: 7, radius: [0.09, 0.13], mass: [0.9, 1.25], roundness: [0.45, 0.85], grip: [0.5, 0.9], restitution: [0.3, 0.55], ecc: [0.3, 0.8], shape: 'rock', pattern: 'speckle', colors: [0xc9c4ba, 0xd1cabd], accent: [0x2e2c2a, 0xf7f4ee] }),
  kind({ id: 'band', noun: 'しまもよう いし', weight: 6, radius: [0.09, 0.13], mass: [0.85, 1.2], roundness: [0.55, 0.9], grip: [0.5, 0.9], restitution: [0.3, 0.5], ecc: [0.3, 0.8], shape: 'smooth', pattern: 'band', colors: [0x6f6862, 0x7d6a5a, 0x5e6266], accent: [0xf1ece2] }),
  // 軽石：かるくて、蹴るとよく飛ぶ
  kind({ id: 'pumice', noun: 'かるいし', weight: 5, radius: [0.1, 0.14], mass: [0.5, 0.62], roundness: [0.4, 0.75], grip: [0.7, 1], restitution: [0.45, 0.6], ecc: [0.3, 0.7], shape: 'rock', pattern: 'pores', colors: [0xd9d2c3, 0xcfc8b8, 0xe2dccd], accent: [0x9b9282] }),
  // レンガのかけら：角があってごろんごろん転がる
  kind({ id: 'brick', noun: 'レンガの かけら', weight: 5, radius: [0.09, 0.12], mass: [0.9, 1.15], roundness: [0.15, 0.3], grip: [0.6, 1], restitution: [0.25, 0.4], ecc: [0.4, 0.8], shape: 'brick', colors: [0xa4553a, 0xb4623f, 0x93492f] }),
  // ここから めずらしい石
  kind({ id: 'heart', noun: 'ハートの いし', weight: 1.2, rare: true, radius: [0.1, 0.13], mass: [0.85, 1.1], roundness: [0.3, 0.5], grip: [0.6, 0.9], restitution: [0.3, 0.45], ecc: [0.5, 0.9], shape: 'heart', colors: [0xc49a8e, 0xb7a294, 0xd0a79b] }),
  kind({ id: 'fossil', noun: 'アンモナイトの かせき', weight: 1, rare: true, radius: [0.11, 0.14], mass: [1.0, 1.3], roundness: [0.35, 0.55], grip: [0.6, 0.9], restitution: [0.25, 0.4], ecc: [0.3, 0.6], shape: 'disc', pattern: 'spiral', colors: [0xc2a77c, 0xb89c72], accent: [0x3f2f1c] }),
  // 水晶：つるつるで回転が効かず、すべるように転がる
  kind({ id: 'crystal', noun: 'すいしょう', weight: 0.8, rare: true, radius: [0.09, 0.12], mass: [0.8, 1.0], roundness: [0.7, 0.85], grip: [0.2, 0.35], restitution: [0.4, 0.55], ecc: [0.2, 0.5], shape: 'crystal', colors: [0xe9e4f5, 0xdcd0f0, 0xf2eef8] }),
  kind({ id: 'glow', noun: 'ひかる いし', weight: 0.5, rare: true, radius: [0.09, 0.12], mass: [0.8, 1.1], roundness: [0.6, 0.9], grip: [0.5, 0.9], restitution: [0.35, 0.55], ecc: [0.2, 0.6], shape: 'smooth', colors: [0xbfe6d0, 0xc9e8f2], glow: 0x5fd6b0 }),
];

export const stoneKindById = (id: string) => STONE_KINDS.find((k) => k.id === id) ?? STONE_KINDS[0];

const pick = (rand: () => number, [a, b]: Range) => a + rand() * (b - a);

function pickKind(rand: () => number): StoneKind {
  const total = STONE_KINDS.reduce((s, k) => s + k.weight, 0);
  let x = rand() * total;
  for (const k of STONE_KINDS) {
    x -= k.weight;
    if (x < 0) return k;
  }
  return STONE_KINDS[0];
}

function rollTraits(k: StoneKind, rand: () => number): StoneTraits {
  const roundness = pick(rand, k.roundness);
  return {
    radius: pick(rand, k.radius),
    mass: pick(rand, k.mass),
    roundness,
    grip: pick(rand, k.grip),
    restitution: pick(rand, k.restitution),
    eccentricity: (1 - roundness) * pick(rand, k.ecc),
  };
}

/** 石の性格から呼び名をつける（数値を見せずに個性を伝える） */
export function stoneName(k: StoneKind, t: StoneTraits): string {
  const words: string[] = [];
  if (t.radius > 0.125) words.push('おおきな');
  else if (t.radius < 0.1) words.push('ちいさな');
  // 軽石・黒い石は名前が重さを語る
  if (k.id !== 'pumice' && k.id !== 'black') {
    if (t.mass > 1.15) words.push('おもたい');
    else if (t.mass < 0.85) words.push('かるい');
  }
  let noun = k.noun;
  if (k.id === 'plain') {
    noun =
      t.roundness > 0.82 ? 'まるいし'
        : t.eccentricity > 0.45 ? 'いびつな いし'
          : t.roundness < 0.4 ? 'ごつごつ いし'
            : t.restitution > 0.52 ? 'よくはねる いし'
              : 'いし';
    if (words.length === 0 && noun === 'いし') words.push('みちばたの');
  }
  return [...words, noun].join(' ');
}

/** 種と性格。乱数列を消費するので、見た目づくりはこの続きで行う */
function rollStone(rand: () => number) {
  const k = pickKind(rand);
  const traits = rollTraits(k, rand);
  return { kind: k, traits, name: stoneName(k, traits) };
}

/** 種（seed）から石の種類と名前だけを知る（描画しない） */
export const describeStone = (seed: number) => rollStone(createRng(seed));

export interface StoneEvents {
  /** 塀・電柱・地面にぶつかった。strength は 0..1 程度 */
  onImpact?: (strength: number) => void;
}

export class Stone {
  readonly mesh: THREE.Mesh;
  readonly traits: StoneTraits;
  readonly kind: StoneKind;
  readonly name: string;
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
  /** 接地表示用の頂点（ローカル座標） */
  private readonly hull: Float32Array;

  constructor(
    seed: number,
    private readonly level: Level,
    private readonly events: StoneEvents = {},
  ) {
    const rand = createRng(seed);
    const rolled = rollStone(rand);
    this.kind = rolled.kind;
    this.traits = rolled.traits;
    this.name = rolled.name;
    this.wobbleOffset = rand() * Math.PI * 2;
    const geo = makeStoneGeometry(this.kind, this.traits, rand);
    paintStone(geo, this.kind, rand);
    this.hull = (geo.attributes.position as THREE.BufferAttribute).array as Float32Array;
    this.mesh = new THREE.Mesh(geo, makeStoneMaterial(this.kind));
    this.mesh.castShadow = true;
    // 道ばたの石は平たい面を下にして落ちている
    this.mesh.rotation.set((rand() - 0.5) * 0.3, rand() * 6, (rand() - 0.5) * 0.3);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  place(x: number, z: number) {
    this.position.set(x, this.level.groundAt(x, z) + this.traits.radius, z);
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
    return this.level.groundAt(this.position.x, this.position.z) + this.traits.radius;
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
    if (!this.moving) {
      this.settle(dt);
      return;
    }
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

      // 坂：下り向きに転がり落ちようとする（転がる物体なので重力の約 5/7）
      if (grounded && this.level.slopes.length) {
        const e = 0.05;
        const L = this.level;
        const gx = (L.terrainAt(p.x + e, p.z) - L.terrainAt(p.x - e, p.z)) / (2 * e);
        const gz = (L.terrainAt(p.x, p.z + e) - L.terrainAt(p.x, p.z - e)) / (2 * e);
        v.x -= G * 0.71 * gx * dt;
        v.z -= G * 0.71 * gz * dt;
      }

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
      // 下り坂では路面に沿って転がる（縁石のような段差は落ちる）
      if (grounded) {
        const nf = this.floor;
        if (p.y > nf && p.y - nf < 0.05) p.y = nf;
      }
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

  /** 止まったら、いちばん薄い向き（ローカル y）を上下にそろえて寝かせる */
  private settle(dt: number) {
    const up = this.tmpAxis.set(0, 1, 0).applyQuaternion(this.mesh.quaternion);
    const c = Math.abs(up.y);
    if (c > 0.999) return;
    const angle = Math.acos(c);
    // up → ±Y への回転軸 = up × (±Y)
    const sgn = up.y >= 0 ? 1 : -1;
    this.tmpAxis.set(-up.z * sgn, 0, up.x * sgn).normalize();
    this.tmpQuat.setFromAxisAngle(this.tmpAxis, Math.min(angle, dt * 5));
    this.mesh.quaternion.premultiply(this.tmpQuat);
    this.syncMesh();
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

    const level = this.level;
    for (const w of level.walls) {
      // 線分上の最近点
      const sx = w.x2 - w.x1;
      const sz = w.z2 - w.z1;
      const tt = Math.max(0, Math.min(1, ((p.x - w.x1) * sx + (p.z - w.z1) * sz) / (sx * sx + sz * sz)));
      this.pushOut(w.x1 + sx * tt, w.z1 + sz * tt, r);
    }
    for (const pole of level.poles) this.pushOut(pole.x, pole.z, r + pole.radius);
    // 縁石：車道側にいて、石の底が縁石の上面より低いときだけ跳ね返る
    if (p.y - r < CURB_HEIGHT - 0.02) {
      for (const c of level.curbs) {
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
      for (const list of [level.blocks, obstacles]) {
        for (const o of list) this.pushOut(Math.max(o.x0, Math.min(o.x1, p.x)), Math.max(o.z0, Math.min(o.z1, p.z)), r);
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
    // 物理は球で計算するが、表示は形の一番低い点が地面に触れるように下ろす。
    // いびつな石は転がるたびに自然とコトコト上下する
    const q = this.mesh.quaternion;
    const h = this.hull;
    // 回転後の y = 2(xy+wz)·x + (1-2(xx+zz))·y + 2(yz-wx)·z
    const ax = 2 * (q.x * q.y + q.w * q.z);
    const ay = 1 - 2 * (q.x * q.x + q.z * q.z);
    const az = 2 * (q.y * q.z - q.w * q.x);
    let minY = 0;
    for (let i = 0; i < h.length; i += 3) {
      const y = ax * h[i] + ay * h[i + 1] + az * h[i + 2];
      if (y < minY) minY = y;
    }
    this.mesh.position.set(this.position.x, this.position.y - this.traits.radius - minY, this.position.z);
  }
}

/** 形ごとの土台。半径 1 前後の大きさで作り、最後に radius 倍する */
function baseGeometry(k: StoneKind, t: StoneTraits, rand: () => number): THREE.BufferGeometry {
  switch (k.shape) {
    case 'brick': {
      const g = new THREE.BoxGeometry(1.6, 0.85, 1.05, 2, 1, 1);
      // 割れた角を少し欠く
      return jitter(g, rand, 0.07, 1, 1, 1);
    }
    case 'heart': {
      const s = new THREE.Shape();
      s.moveTo(0, -0.95);
      s.bezierCurveTo(-0.35, -0.6, -1.0, -0.25, -0.95, 0.25);
      s.bezierCurveTo(-0.9, 0.8, -0.25, 0.85, 0, 0.45);
      s.bezierCurveTo(0.25, 0.85, 0.9, 0.8, 0.95, 0.25);
      s.bezierCurveTo(1.0, -0.25, 0.35, -0.6, 0, -0.95);
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.12, bevelSegments: 2, curveSegments: 7 });
      g.center();
      g.rotateX(-Math.PI / 2);
      return jitter(g, rand, 0.025, 1, 1, 1);
    }
    case 'crystal': {
      // 六角柱の両端がとがった結晶
      const pts = [new THREE.Vector2(0, -1.05), new THREE.Vector2(0.36, -0.6), new THREE.Vector2(0.36, 0.6), new THREE.Vector2(0, 1.05)];
      const g = new THREE.LatheGeometry(pts, 6);
      g.rotateZ(Math.PI / 2);
      return jitter(g, rand, 0.03, 1, 1, 1);
    }
    case 'smooth':
      return jitter(new THREE.IcosahedronGeometry(1, 2), rand, 0.025, 1.12, 0.78, 1);
    case 'flat':
      return jitter(new THREE.IcosahedronGeometry(1, 1), rand, 0.06, 1.12, 0.42, 1);
    case 'disc':
      return jitter(new THREE.IcosahedronGeometry(1, 3), rand, 0.01, 1, 0.5, 1);
    case 'gravel':
      return jitter(new THREE.IcosahedronGeometry(1, 0), rand, 0.28, 1.15, 0.85, 1);
    case 'rock': {
      // 丸くない石ほど扁平・細長く、表面の凸凹も大きい
      const detail = k.pattern === 'plain' ? 1 : 2;
      const flat = 1 - (1 - t.roundness) * 0.45;
      const long = 1 + (1 - t.roundness) * 0.35;
      const bumps = 0.04 + (1 - t.roundness) * 0.14;
      return jitter(new THREE.IcosahedronGeometry(1, detail), rand, bumps, long, flat, 1);
    }
  }
}

/** 頂点を共有させてから凸凹を付け、軸ごとに伸び縮みさせる */
function jitter(g: THREE.BufferGeometry, rand: () => number, bumps: number, sx: number, sy: number, sz: number) {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const geo = mergeVertices(g);
  g.dispose();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + (rand() * 2 - 1) * bumps);
    pos.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  return geo;
}

function makeStoneGeometry(k: StoneKind, t: StoneTraits, rand: () => number): THREE.BufferGeometry {
  const geo = baseGeometry(k, t, rand);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // 偏心：片側だけ少し膨らませる
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x > 0) pos.setX(i, x * (1 + t.eccentricity * 0.25));
  }
  geo.scale(t.radius, t.radius, t.radius);
  geo.computeVertexNormals();
  return geo;
}

/** 頂点色で色むらと模様を描く */
function paintStone(geo: THREE.BufferGeometry, k: StoneKind, rand: () => number) {
  const base = new THREE.Color(k.colors[Math.floor(rand() * k.colors.length)]);
  base.offsetHSL(0, 0, (rand() - 0.5) * 0.08);
  const accent = k.accent?.map((c) => new THREE.Color(c)) ?? [];
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  geo.computeBoundingSphere();
  const R = geo.boundingSphere!.radius;
  const axis = new THREE.Vector3(rand() - 0.5, rand() * 0.4, rand() - 0.5).normalize();
  const bandFreq = 9 + rand() * 6;
  const bandPhase = rand() * 6;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).divideScalar(R);
    c.copy(base).offsetHSL(0, 0, (rand() - 0.5) * 0.06);
    switch (k.pattern) {
      case 'speckle': {
        const r = rand();
        if (r < 0.16) c.copy(accent[0]);
        else if (r < 0.26) c.copy(accent[1]);
        break;
      }
      case 'pores':
        if (rand() < 0.3) c.lerp(accent[0], 0.6);
        break;
      case 'band': {
        // 石英の白い筋が1〜2本走る
        const b = Math.sin(v.dot(axis) * bandFreq + bandPhase);
        if (b > 0.82) c.copy(accent[0]).offsetHSL(0, 0, (rand() - 0.5) * 0.04);
        break;
      }
      case 'spiral': {
        // 上下の面にだけ、巻きと肋（ろく）を彫る
        const rr = Math.hypot(v.x, v.z);
        if (Math.abs(v.y) > 0.12 && rr > 0.06) {
          const th = Math.atan2(v.z, v.x);
          const coil = (th / (Math.PI * 2) - Math.log(rr) / Math.log(2.2)) % 1;
          const groove = (coil + 1) % 1 < 0.2;
          const rib = Math.sin(th * 14 + Math.log(rr) * 6) > 0.4 && rr > 0.25;
          if (groove) c.copy(accent[0]);
          else if (rib) c.lerp(accent[0], 0.6);
        }
        break;
      }
      case 'plain':
        break;
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function makeStoneMaterial(k: StoneKind): THREE.Material {
  if (k.shape === 'crystal') {
    return new THREE.MeshPhongMaterial({
      vertexColors: true,
      flatShading: true,
      transparent: true,
      opacity: 0.78,
      shininess: 120,
      specular: 0xffffff,
      emissive: 0x403850,
    });
  }
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    emissive: k.glow ?? 0x000000,
    emissiveIntensity: k.glow ? 0.55 : 0,
  });
}
