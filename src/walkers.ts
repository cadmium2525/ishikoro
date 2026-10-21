import * as THREE from 'three';
import { createRng } from './rng';
import type { Level } from './level';
import type { Traffic } from './traffic';

/** 石を当ててはいけない相手 */
export type WalkerKind = 'person' | 'bike' | 'dog' | 'cat';

/** 帰り道の中心からどれだけ横へよけられるか */
const LATERAL = 0.55;
/** よけるときに石や子どもとあける間隔 */
const PASS_GAP = 0.45;

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

interface Body {
  kind: WalkerKind;
  x: number;
  z: number;
  radius: number;
}

/** 通行人（犬を連れていることもある） */
interface Person {
  /** 帰り道の上の道のりと、中心からの横のずれ */
  s: number;
  l: number;
  lTarget: number;
  dir: 1 | -1;
  speed: number;
  wait: number;
  phase: number;
  mesh: THREE.Group;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  wheels: THREE.Object3D[];
  /** 自転車に乗っている（速く、当たり判定も大きい） */
  bike: boolean;
  /** 自転車のベルをもう鳴らしたか */
  rang: boolean;
  /** 石を当てられて怒っている時間（-1：怒っていない） */
  angry: number;
  radius: number;
  dog: Dog | null;
}

interface Dog {
  mesh: THREE.Group;
  legs: THREE.Object3D[];
  leash: THREE.Line;
  x: number;
  z: number;
}

/** 道ばたのねこ。ときどき道を横切る */
interface Cat {
  s: number;
  l: number;
  lTarget: number;
  /** 次に動き出すまで */
  timer: number;
  /** 転がる石に一度驚いたら、石が止まるまでは驚かない */
  startled: boolean;
  /** 石を当てられて怒っている時間（-1：怒っていない） */
  angry: number;
  mesh: THREE.Group;
  x: number;
  z: number;
}

/**
 * 帰り道を行き来する通行人・散歩の犬・ねこ。
 * 帰り道の中心線に沿って歩くので、塀や側溝には入らない。止まっている石や子どもは横へよけ、
 * よけられなければ待つ。信号のある横断歩道では歩行者信号を守る。
 */
export class Walkers {
  readonly group = new THREE.Group();
  private readonly people: Person[] = [];
  private readonly cats: Cat[] = [];
  private readonly rand: () => number;
  private readonly target: number;
  private time = 0;
  /** 音を鳴らすきっかけ（自転車のベル、ねこの声） */
  onBell?: () => void;
  onMeow?: () => void;

  constructor(private readonly level: Level) {
    this.rand = createRng(level.seed ^ 0x1b873593);
    const d = level.difficulty;
    this.target = { easy: 3, normal: 6, hard: 9 }[d];
    const cats = { easy: 1, normal: 3, hard: 4 }[d];
    for (let i = 0; i < cats; i++) {
      // 車道の上（横断歩道）には座らせない
      let s = 20 + this.rand() * Math.max(10, level.routeLength - 35);
      for (let k = 0; k < 10 && level.carRoadAt(...this.pointAt(s, 0)); k++) s = 20 + this.rand() * Math.max(10, level.routeLength - 35);
      const l = (this.rand() < 0.5 ? -1 : 1) * LATERAL;
      const cat: Cat = { s, l, lTarget: l, timer: 3 + this.rand() * 6, startled: false, angry: -1, mesh: buildCat(this.rand), x: 0, z: 0 };
      this.cats.push(cat);
      this.group.add(cat.mesh);
    }
  }

  /** 最初の配置：石より先に、ばらけて */
  reset(stoneS: number) {
    for (const p of this.people) this.removePerson(p);
    this.people.length = 0;
    for (let i = 0; i < this.target; i++) this.spawn(stoneS, 15 + (i / this.target) * Math.max(20, this.level.routeLength - 20));
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }

  /** 車が止まる相手（通行人と犬） */
  get pedestrians(): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (const p of this.people) {
      out.push(p.mesh.position);
      if (p.dog) out.push(p.dog);
    }
    return out;
  }

  /** 当たり判定用の体 */
  bodies(): Body[] {
    const out: Body[] = [];
    for (const p of this.people) {
      out.push({ kind: p.bike ? 'bike' : 'person', x: p.mesh.position.x, z: p.mesh.position.z, radius: p.radius });
      if (p.dog) out.push({ kind: 'dog', x: p.dog.x, z: p.dog.z, radius: 0.26 });
    }
    for (const c of this.cats) out.push({ kind: 'cat', x: c.x, z: c.z, radius: 0.18 });
    return out;
  }

  /** 動いている石が誰かに当たったか。当たった相手は怒りだす */
  strike(x: number, z: number, y: number, radius: number): WalkerKind | null {
    if (y - radius > 1.2) return null;
    for (const p of this.people) {
      const hitPerson = Math.hypot(p.mesh.position.x - x, p.mesh.position.z - z) < p.radius + radius;
      const hitDog = !!p.dog && Math.hypot(p.dog.x - x, p.dog.z - z) < 0.26 + radius;
      if (!hitPerson && !hitDog) continue;
      p.angry = 0;
      this.scolder = { person: p, cat: null, text: hitDog ? pick(DOG_LINES) : p.bike ? pick(BIKE_LINES) : pick(PERSON_LINES) };
      return hitDog ? 'dog' : p.bike ? 'bike' : 'person';
    }
    for (const c of this.cats) {
      if (Math.hypot(c.x - x, c.z - z) >= 0.18 + radius) continue;
      c.angry = 0;
      this.scolder = { person: null, cat: c, text: 'シャーッ！' };
      return 'cat';
    }
    return null;
  }

  /** 怒っている相手の頭の上の位置と、言っていること（吹き出し用） */
  get speech(): { x: number; y: number; z: number; text: string } | null {
    const s = this.scolder;
    if (!s) return null;
    if (s.person) {
      const m = s.person.mesh;
      return { x: m.position.x, y: m.position.y + 1.85 * m.scale.y + (s.person.bike ? 0.2 : 0), z: m.position.z, text: s.text };
    }
    const c = s.cat!;
    return { x: c.x, y: c.mesh.position.y + 0.6, z: c.z, text: s.text };
  }

  private scolder: { person: Person | null; cat: Cat | null; text: string } | null = null;

  /** stoneMoving：転がっている石はよけない（気づかずに当たる） */
  update(dt: number, stone: THREE.Vector3, stoneMoving: boolean, kid: THREE.Vector3, traffic: Traffic) {
    this.time += dt;
    const L = this.level;
    const stoneS = L.routeProgress(stone.x, stone.z);
    // 帰り道の座標での石と子ども（よける相手）
    const kidS = L.routeProgress(kid.x, kid.z);
    const obstacles = [{ s: kidS, l: this.lateralOf(kid.x, kid.z, kidS), r: 0.22 }];
    if (!stoneMoving) obstacles.push({ s: stoneS, l: this.lateralOf(stone.x, stone.z, stoneS), r: 0.13 });

    for (const p of [...this.people]) {
      // 石を当てられた人は立ち止まり、子どもの方を向いて怒る
      if (p.angry >= 0) {
        p.angry += dt;
        this.scold(p, dt, kid);
        continue;
      }
      // 前方の石や子どもを横へよける。よけられなければ待つ
      let blocked = false;
      p.lTarget = p.lTarget * 0.98;
      for (const o of obstacles) {
        const ahead = (o.s - p.s) * p.dir;
        if (ahead < -0.3 || ahead > 2.2) continue;
        const need = o.r + p.radius + PASS_GAP * 0.5;
        if (Math.abs(p.l - o.l) >= need) continue;
        const side = p.l >= o.l ? 1 : -1;
        const want = o.l + side * need;
        if (Math.abs(want) <= LATERAL) p.lTarget = want;
        else if (Math.abs(o.l - side * need) <= LATERAL) p.lTarget = o.l - side * need;
        else blocked = true;
        if (ahead < 0.8 && Math.abs(p.l - p.lTarget) > 0.08) blocked = true;
      }
      p.l += Math.sign(p.lTarget - p.l) * Math.min(Math.abs(p.lTarget - p.l), 0.9 * dt);

      // 車道へ出る前は、信号や車を確かめる
      const [nx, nz] = this.pointAt(p.s + p.dir * 0.6, p.l);
      const road = L.carRoadAt(nx, nz);
      const [cx, cz] = this.pointAt(p.s, p.l);
      if (road && road !== L.carRoadAt(cx, cz) && !traffic.mayCross(road, nx, nz, nx, nz)) blocked = true;

      if (blocked) {
        p.wait += dt;
        // 長く待たされたら引き返す
        if (p.wait > 6) {
          p.dir = (-p.dir) as 1 | -1;
          p.wait = 0;
        }
      } else {
        p.wait = 0;
        p.s += p.dir * p.speed * dt;
        p.phase += dt * p.speed * (p.bike ? 2.2 : 5);
      }
      this.placePerson(p, blocked ? 0 : p.speed, dt);
      // 自転車は子どもに近づくとベルを鳴らす
      if (p.bike && !p.rang && Math.hypot(p.mesh.position.x - kid.x, p.mesh.position.z - kid.z) < 9 && (kidS - p.s) * p.dir > 0) {
        p.rang = true;
        this.onBell?.();
      }

      // 子どもの後ろへ遠く離れた人や、道の端まで行った人は、先の方に入れ替える
      const behind = (stoneS - p.s) > 25 || p.s < 0 || p.s > L.routeLength;
      if (behind) {
        this.removePerson(p);
        this.people.splice(this.people.indexOf(p), 1);
        this.spawn(stoneS, stoneS + 25 + this.rand() * 35);
      }
    }

    for (const c of this.cats) this.updateCat(c, dt, kid, stone, stoneMoving);
  }

  // ---------- 内部 ----------

  /** 帰り道の点 s から横へ l ずらした位置 */
  private pointAt(s: number, l: number): [number, number] {
    const L = this.level;
    const [x, z] = L.routePoint(s);
    const [ax, az] = L.routePoint(s - 0.4);
    const [bx, bz] = L.routePoint(s + 0.4);
    const tx = bx - ax;
    const tz = bz - az;
    const n = Math.hypot(tx, tz) || 1;
    // 進む向きの右手側を正にする
    return [x - (tz / n) * l, z + (tx / n) * l];
  }

  private lateralOf(x: number, z: number, s: number): number {
    const L = this.level;
    const [px, pz] = L.routePoint(s);
    const [ax, az] = L.routePoint(s - 0.4);
    const [bx, bz] = L.routePoint(s + 0.4);
    const tx = bx - ax;
    const tz = bz - az;
    const n = Math.hypot(tx, tz) || 1;
    return (-(tz / n) * (x - px) + (tx / n) * (z - pz));
  }

  private spawn(stoneS: number, s: number) {
    const L = this.level;
    if (s > L.routeLength - 2) s = stoneS + 15 + this.rand() * Math.max(1, L.routeLength - stoneS - 17);
    if (s - stoneS < 12 || s > L.routeLength - 1) return;
    // 多くは向こうから歩いてくる
    const dir: 1 | -1 = this.rand() < 0.7 ? -1 : 1;
    const bike = this.rand() < { easy: 0.1, normal: 0.25, hard: 0.35 }[L.difficulty];
    const withDog = !bike && this.rand() < 0.35;
    const l = (this.rand() * 2 - 1) * LATERAL;
    const person: Person = {
      s,
      l,
      lTarget: l,
      dir,
      speed: bike ? 3.0 + this.rand() * 0.6 : dir < 0 ? 1.0 + this.rand() * 0.4 : 0.7 + this.rand() * 0.3,
      wait: 0,
      phase: this.rand() * 6,
      ...buildPerson(this.rand, bike),
      bike,
      rang: false,
      angry: -1,
      radius: bike ? 0.42 : 0.26,
      dog: null,
    };
    if (withDog) {
      const dog = buildDog(this.rand);
      const leash = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xc0503a }));
      person.dog = { ...dog, leash, x: 0, z: 0 };
      this.group.add(dog.mesh, leash);
    }
    this.people.push(person);
    this.group.add(person.mesh);
    this.placePerson(person, 0, 0);
  }

  private removePerson(p: Person) {
    this.group.remove(p.mesh);
    if (p.dog) this.group.remove(p.dog.mesh, p.dog.leash);
  }

  private placePerson(p: Person, speed: number, dt: number) {
    const L = this.level;
    const [x, z] = this.pointAt(p.s, p.l);
    const [fx, fz] = this.pointAt(p.s + p.dir * 0.5, p.l);
    p.mesh.position.set(x, L.groundAt(x, z), z);
    const heading = Math.atan2(fx - x, fz - z);
    p.mesh.rotation.y = heading;
    if (p.bike) {
      // ペダルをこぐ脚と、回る車輪
      const pedal = speed > 0 ? Math.sin(p.phase) * 0.45 : 0;
      p.legs[0].rotation.x = -0.9 + pedal;
      p.legs[1].rotation.x = -0.9 - pedal;
      for (const w of p.wheels) w.rotation.x += (speed * dt) / 0.33;
    } else {
      // 脚と、反対側の腕を振って歩く
      const swing = speed > 0 ? Math.sin(p.phase) * 0.5 : 0;
      p.legs[0].rotation.x = swing;
      p.legs[1].rotation.x = -swing;
      p.arms[0].rotation.x = -swing * 0.7;
      p.arms[1].rotation.x = swing * 0.7;
    }

    if (p.dog) {
      // 犬は飼い主の少し前を、左右にうろうろしながら歩く
      const wob = Math.sin(this.time * 1.7 + p.phase) * 0.25;
      const dl = Math.max(-LATERAL, Math.min(LATERAL, p.l + (p.l > 0 ? -0.35 : 0.35) + wob));
      const [dx, dz] = this.pointAt(p.s + p.dir * 1.0, dl);
      const d = p.dog;
      d.x += (dx - d.x) * Math.min(1, dt * 6 || 1);
      d.z += (dz - d.z) * Math.min(1, dt * 6 || 1);
      d.mesh.position.set(d.x, L.groundAt(d.x, d.z), d.z);
      d.mesh.rotation.y = heading + wob * 0.6;
      const ds = speed > 0 ? Math.sin(p.phase * 1.8) * 0.6 : 0;
      d.legs.forEach((leg, i) => (leg.rotation.x = i % 2 ? ds : -ds));
      // リード：手から首輪へ
      const pos = d.leash.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, x + Math.sin(heading) * 0.15, p.mesh.position.y + 0.85, z + Math.cos(heading) * 0.15);
      pos.setXYZ(1, d.x, d.mesh.position.y + 0.35, d.z);
      pos.needsUpdate = true;
    }
  }

  /** 怒っている人：子どもの方を向き、腕を振り上げる。犬は吠えて跳ねる */
  private scold(p: Person, dt: number, kid: THREE.Vector3) {
    const m = p.mesh;
    const face = Math.atan2(kid.x - m.position.x, kid.z - m.position.z);
    let d = face - m.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    m.rotation.y += d * Math.min(1, dt * 8);
    p.legs[0].rotation.x = 0;
    p.legs[1].rotation.x = 0;
    if (!p.bike) {
      // 右腕を振り上げて、こらっ
      p.arms[1].rotation.x = -2.5 + Math.sin(p.angry * 12) * 0.35;
      p.arms[0].rotation.x = 0;
    }
    if (p.dog) {
      const dog = p.dog.mesh;
      const df = Math.atan2(kid.x - dog.position.x, kid.z - dog.position.z);
      dog.rotation.y = df;
      dog.position.y = this.level.groundAt(dog.position.x, dog.position.z) + Math.abs(Math.sin(p.angry * 11)) * 0.15;
    }
  }

  private updateCat(c: Cat, dt: number, kid: THREE.Vector3, stone: THREE.Vector3, stoneMoving: boolean) {
    const L = this.level;
    const [kx, kz] = [kid.x, kid.z];
    // 石を当てられたねこは、背中を立ててシャーッと怒り、それから逃げていく
    if (c.angry >= 0) {
      c.angry += dt;
      const arch = c.angry < 1.2 ? 1.3 : 1;
      c.mesh.scale.set(1, c.mesh.scale.y + (arch - c.mesh.scale.y) * Math.min(1, dt * 10), 1);
      c.mesh.rotation.y = Math.atan2(kx - c.x, kz - c.z);
      if (c.angry > 1.2) {
        c.lTarget = c.l >= 0 ? 2.5 : -2.5;
        c.l += Math.sign(c.lTarget - c.l) * Math.min(Math.abs(c.lTarget - c.l), 2.5 * dt);
        const [x, z] = this.pointAt(c.s, c.l);
        c.x = x;
        c.z = z;
        c.mesh.position.set(x, L.groundAt(x, z), z);
      }
      return;
    }
    // 転がってくる石に驚いて、反対側へ飛び出す（道を横切るので危ない）
    if (stoneMoving && Math.hypot(stone.x - c.x, stone.z - c.z) < 3 && Math.abs(c.lTarget - c.l) < 0.02 && !c.startled) {
      c.startled = true;
      c.lTarget = c.l > 0 ? -LATERAL : LATERAL;
      this.onMeow?.();
    }
    if (!stoneMoving) c.startled = false;
    // 子どもが近づくと、道の端へ逃げる
    if (Math.hypot(kx - c.x, kz - c.z) < 1.6 && Math.abs(c.lTarget) < LATERAL) {
      c.lTarget = c.l >= 0 ? LATERAL + 0.3 : -LATERAL - 0.3;
      this.onMeow?.();
    }
    c.timer -= dt;
    if (c.timer <= 0) {
      // ときどき道を横切る
      c.lTarget = c.l > 0 ? -LATERAL : LATERAL;
      c.timer = 4 + this.rand() * 7;
    }
    const moving = Math.abs(c.lTarget - c.l) > 0.02;
    c.l += Math.sign(c.lTarget - c.l) * Math.min(Math.abs(c.lTarget - c.l), 1.4 * dt);
    const [x, z] = this.pointAt(c.s, c.l);
    c.x = x;
    c.z = z;
    c.mesh.position.set(x, L.groundAt(x, z), z);
    // 進む向き（横切るときは横を向く）
    const [fx, fz] = this.pointAt(c.s, c.l + (c.lTarget > c.l ? 0.3 : -0.3));
    if (moving) c.mesh.rotation.y = Math.atan2(fx - x, fz - z);
    const tail = c.mesh.userData.tail as THREE.Object3D;
    tail.rotation.z = Math.sin(this.time * (moving ? 9 : 2)) * 0.4;
  }
}

const PERSON_LINES = ['こらっ！', 'あぶないでしょ！', 'いたっ！ 気をつけなさい！'];
const BIKE_LINES = ['あぶないなぁ！', 'こらー！ 道で石を蹴らない！'];
const DOG_LINES = ['うちの子に何するの！', 'ワンワン！ こらっ！'];
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];

// ---------- 見た目 ----------

interface PersonModel {
  mesh: THREE.Group;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  wheels: THREE.Object3D[];
}

/** 歩く人か、自転車に乗った人 */
function buildPerson(rand: () => number, bike: boolean): PersonModel {
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const g = new THREE.Group();
  const coat = lambert(pick([0x6b7a8f, 0x8a6f5a, 0xb8a58a, 0x55705e, 0x9a5a5a, 0xd9d4c8]));
  const pants = lambert(pick([0x3c4250, 0x4f4a44, 0x2e3a4a]));
  const skin = lambert(pick([0xf1c9a5, 0xe0b18c, 0xd29b74]));
  const hair = lambert(pick([0x2b211b, 0x6b6560, 0xbdb8b0, 0x3a2a1e]));
  const scale = 1.35 + rand() * 0.15;
  // 自転車では腰の位置がサドルの高さになる
  const lift = bike ? 0.18 : 0;
  const legs: THREE.Object3D[] = [];
  for (const x of [0.1, -0.1]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.75 + lift, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.72, 0.14), pants);
    leg.position.y = -0.37;
    leg.castShadow = true;
    hip.add(leg);
    g.add(hip);
    legs.push(hip);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.24), coat);
  body.position.y = 1.06 + lift;
  body.castShadow = true;
  g.add(body);
  // 腕（肩を軸に振る）。手の先まで
  const arms: THREE.Object3D[] = [];
  for (const x of [0.26, -0.26]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.32 + lift, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.56, 0.11), coat);
    arm.position.y = -0.28;
    arm.castShadow = true;
    shoulder.add(arm);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), skin);
    hand.position.y = -0.6;
    shoulder.add(hand);
    g.add(shoulder);
    arms.push(shoulder);
  }
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), skin);
  head.position.y = 1.52 + lift;
  head.castShadow = true;
  g.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.155, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), hair);
  cap.position.y = 1.54 + lift;
  g.add(cap);

  const wheels: THREE.Object3D[] = [];
  if (bike) {
    // 自転車：前後の車輪、フレーム、ハンドル。腕はハンドルへ伸ばす
    const frame = lambert(pick([0x3f6e8a, 0xc0503a, 0xf4f1ea, 0x55705e]));
    const tire = lambert(0x222222);
    const wheelGeo = new THREE.TorusGeometry(0.33, 0.04, 5, 14);
    wheelGeo.rotateY(Math.PI / 2);
    for (const z of [0.55, -0.55]) {
      const w = new THREE.Mesh(wheelGeo, tire);
      w.position.set(0, 0.35, z);
      g.add(w);
      wheels.push(w);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.0), frame);
    bar.position.set(0, 0.62, 0.05);
    g.add(bar);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.05), frame);
    post.position.set(0, 0.62, 0.5);
    g.add(post);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.04), lambert(0x888888));
    handle.position.set(0, 0.88, 0.5);
    g.add(handle);
    const basket = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.25), lambert(0x9a9a9a));
    basket.position.set(0, 0.85, 0.72);
    g.add(basket);
    for (const a of arms) a.rotation.x = -1.0;
    body.rotation.x = 0.2;
  } else if (rand() < 0.4) {
    // 買い物袋をさげていることも（手に持つ）
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.28), lambert(0xf4efe4));
    bag.position.set(0, -0.78, 0);
    arms[1].add(bag);
  }
  g.scale.setScalar(scale / 1.4);
  return { mesh: g, legs, arms, wheels };
}

function buildDog(rand: () => number): { mesh: THREE.Group; legs: THREE.Object3D[] } {
  const g = new THREE.Group();
  const fur = lambert([0xc9a06a, 0xf2ead8, 0x4a3a2e, 0x8a6a4a][Math.floor(rand() * 4)]);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.5), fur);
  body.position.y = 0.32;
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.2), fur);
  head.position.set(0, 0.45, 0.3);
  head.castShadow = true;
  g.add(head);
  for (const x of [-0.07, 0.07]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 4), fur);
    ear.position.set(x, 0.57, 0.28);
    g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.18), fur);
  tail.position.set(0, 0.42, -0.3);
  tail.rotation.x = 0.7;
  g.add(tail);
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.07, 0.17], [0.07, 0.17], [-0.07, -0.17], [0.07, -0.17]]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.24, z);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.06), fur);
    leg.position.y = -0.12;
    hip.add(leg);
    g.add(hip);
    legs.push(hip);
  }
  return { mesh: g, legs };
}

function buildCat(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  const fur = lambert([0xe08a3c, 0x2a2a2a, 0xf2ead8, 0x8a8580, 0xb98a5a][Math.floor(rand() * 5)]);
  // 座った姿勢
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.26), fur);
  body.position.set(0, 0.12, -0.02);
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.12), fur);
  head.position.set(0, 0.26, 0.1);
  head.castShadow = true;
  g.add(head);
  for (const x of [-0.045, 0.045]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 4), fur);
    ear.position.set(x, 0.35, 0.1);
    g.add(ear);
  }
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.06, -0.15);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.22), fur);
  tail.position.z = -0.1;
  tailPivot.add(tail);
  g.add(tailPivot);
  g.userData.tail = tailPivot;
  return g;
}
