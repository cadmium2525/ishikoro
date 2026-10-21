import * as THREE from 'three';
import { createRng } from './rng';
import type { Level } from './level';
import type { Traffic } from './traffic';

/** 石を当ててはいけない相手 */
export type WalkerKind = 'person' | 'dog' | 'cat';

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

  constructor(private readonly level: Level) {
    this.rand = createRng(level.seed ^ 0x1b873593);
    const d = level.difficulty;
    this.target = { easy: 2, normal: 4, hard: 6 }[d];
    const cats = { easy: 1, normal: 2, hard: 3 }[d];
    for (let i = 0; i < cats; i++) {
      // 車道の上（横断歩道）には座らせない
      let s = 20 + this.rand() * Math.max(10, level.routeLength - 35);
      for (let k = 0; k < 10 && level.carRoadAt(...this.pointAt(s, 0)); k++) s = 20 + this.rand() * Math.max(10, level.routeLength - 35);
      const l = (this.rand() < 0.5 ? -1 : 1) * LATERAL;
      const cat: Cat = { s, l, lTarget: l, timer: 3 + this.rand() * 6, mesh: buildCat(this.rand), x: 0, z: 0 };
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
      out.push({ kind: 'person', x: p.mesh.position.x, z: p.mesh.position.z, radius: 0.26 });
      if (p.dog) out.push({ kind: 'dog', x: p.dog.x, z: p.dog.z, radius: 0.26 });
    }
    for (const c of this.cats) out.push({ kind: 'cat', x: c.x, z: c.z, radius: 0.18 });
    return out;
  }

  /** 動いている石が誰かに当たったか */
  hitTest(x: number, z: number, y: number, radius: number): WalkerKind | null {
    if (y - radius > 1.2) return null;
    for (const b of this.bodies()) {
      if (Math.hypot(b.x - x, b.z - z) < b.radius + radius) return b.kind;
    }
    return null;
  }

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
      // 前方の石や子どもを横へよける。よけられなければ待つ
      let blocked = false;
      p.lTarget = p.lTarget * 0.98;
      for (const o of obstacles) {
        const ahead = (o.s - p.s) * p.dir;
        if (ahead < -0.3 || ahead > 2.2) continue;
        const need = o.r + 0.26 + PASS_GAP * 0.5;
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
        p.phase += dt * p.speed * 5;
      }
      this.placePerson(p, blocked ? 0 : p.speed, dt);

      // 子どもの後ろへ遠く離れた人や、道の端まで行った人は、先の方に入れ替える
      const behind = (stoneS - p.s) > 25 || p.s < 0 || p.s > L.routeLength;
      if (behind) {
        this.removePerson(p);
        this.people.splice(this.people.indexOf(p), 1);
        this.spawn(stoneS, stoneS + 25 + this.rand() * 35);
      }
    }

    for (const c of this.cats) this.updateCat(c, dt, kid);
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
    const withDog = this.rand() < 0.35;
    const l = (this.rand() * 2 - 1) * LATERAL;
    const person: Person = {
      s,
      l,
      lTarget: l,
      dir,
      speed: dir < 0 ? 1.0 + this.rand() * 0.4 : 0.7 + this.rand() * 0.3,
      wait: 0,
      phase: this.rand() * 6,
      ...buildPerson(this.rand),
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
    const swing = speed > 0 ? Math.sin(p.phase) * 0.5 : 0;
    p.legs[0].rotation.x = swing;
    p.legs[1].rotation.x = -swing;

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

  private updateCat(c: Cat, dt: number, kid: THREE.Vector3) {
    const L = this.level;
    const [kx, kz] = [kid.x, kid.z];
    // 子どもが近づくと、道の端へ逃げる
    if (Math.hypot(kx - c.x, kz - c.z) < 1.6 && Math.abs(c.lTarget) < LATERAL) {
      c.lTarget = c.l >= 0 ? LATERAL + 0.3 : -LATERAL - 0.3;
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

// ---------- 見た目 ----------

function buildPerson(rand: () => number): { mesh: THREE.Group; legs: THREE.Object3D[] } {
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const g = new THREE.Group();
  const coat = lambert(pick([0x6b7a8f, 0x8a6f5a, 0xb8a58a, 0x55705e, 0x9a5a5a, 0xd9d4c8]));
  const pants = lambert(pick([0x3c4250, 0x4f4a44, 0x2e3a4a]));
  const skin = lambert(pick([0xf1c9a5, 0xe0b18c, 0xd29b74]));
  const hair = lambert(pick([0x2b211b, 0x6b6560, 0xbdb8b0, 0x3a2a1e]));
  const scale = 1.35 + rand() * 0.15;
  const legs: THREE.Object3D[] = [];
  for (const x of [0.1, -0.1]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.75, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.72, 0.14), pants);
    leg.position.y = -0.37;
    leg.castShadow = true;
    hip.add(leg);
    g.add(hip);
    legs.push(hip);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.24), coat);
  body.position.y = 1.06;
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), skin);
  head.position.y = 1.52;
  head.castShadow = true;
  g.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.155, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), hair);
  cap.position.y = 1.54;
  g.add(cap);
  // 買い物袋を持っていることも
  if (rand() < 0.4) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.28), lambert(0xf4efe4));
    bag.position.set(-0.26, 0.7, 0);
    g.add(bag);
  }
  g.scale.setScalar(scale / 1.4);
  return { mesh: g, legs };
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
