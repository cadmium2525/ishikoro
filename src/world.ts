import * as THREE from 'three';
import { createRng } from './rng';

/** Phase 1: 学校から家まで続くまっすぐな住宅街の道1本 */
export const ROAD_LENGTH = 120;
/** ブロック塀の内側（石が跳ね返る面）の x 座標 */
export const WALL_X = 3.2;
/** 学校の門（スタート背後の壁）の z 座標 */
export const START_WALL_Z = -4;
/** 家の門の位置と、石を置けばクリアになる範囲 */
export const HOME_GATE = { x: 1.6, z: ROAD_LENGTH - 2, halfWidth: 1.0, depth: 1.6 };

/** 石が衝突する円柱（電柱など） */
export interface PoleCollider {
  x: number;
  z: number;
  radius: number;
}

export interface World {
  group: THREE.Group;
  poles: PoleCollider[];
}

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

export function buildWorld(seed: number): World {
  const rand = createRng(seed);
  const group = new THREE.Group();
  const poles: PoleCollider[] = [];

  // 地面（塀の外側の土・庭）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, ROAD_LENGTH + 80), lambert(0xa9b77a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, ROAD_LENGTH / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // アスファルト
  const roadLen = ROAD_LENGTH - START_WALL_Z;
  const road = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X * 2, roadLen), lambert(0x77736e));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0, START_WALL_Z + roadLen / 2);
  road.receiveShadow = true;
  group.add(road);

  // 路側の白線
  const lineMat = lambert(0xeeeae0);
  for (const sx of [-1, 1]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.1, roadLen), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(sx * (WALL_X - 0.75), 0.003, START_WALL_Z + roadLen / 2);
    line.receiveShadow = true;
    group.add(line);
  }

  // 側溝のふた（Phase 1 では見た目のみ。落下判定は Phase 2）
  const lidMat = lambert(0x9d9a92);
  const lidGeo = new THREE.BoxGeometry(0.5, 0.03, 0.98);
  for (const sx of [-1, 1]) {
    const lids = new THREE.InstancedMesh(lidGeo, lidMat, Math.ceil(roadLen));
    const m = new THREE.Matrix4();
    for (let i = 0; i < lids.count; i++) {
      m.makeTranslation(sx * (WALL_X - 0.3), 0.012, START_WALL_Z + 0.5 + i);
      lids.setMatrixAt(i, m);
    }
    lids.receiveShadow = true;
    group.add(lids);
  }

  // ブロック塀
  const wallMat = lambert(0xc9c0ad);
  const capMat = lambert(0xa79f8f);
  const addWall = (x: number, z0: number, z1: number) => {
    const len = z1 - z0;
    if (len <= 0) return;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, len), wallMat);
    wall.position.set(x, 0.6, z0 + len / 2);
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, len), capMat);
    cap.position.set(x, 1.23, z0 + len / 2);
    cap.castShadow = true;
    group.add(cap);
  };
  const wallSide = WALL_X + 0.075;
  addWall(-wallSide, START_WALL_Z, ROAD_LENGTH + 2);
  addWall(wallSide, START_WALL_Z, ROAD_LENGTH + 2);

  // 突き当たりの塀と学校側の塀
  const endWall = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2 + 0.3, 1.2, 0.15), wallMat);
  endWall.position.set(0, 0.6, ROAD_LENGTH + 2);
  endWall.castShadow = true;
  group.add(endWall);
  const schoolWall = endWall.clone();
  schoolWall.position.z = START_WALL_Z - 0.075;
  group.add(schoolWall);

  buildSchool(group);
  buildHome(group);

  // 道沿いの家々
  const houseColors = [0xe9dcc4, 0xd8c7a8, 0xf0e6d6, 0xc7b79c, 0xe2d2bd];
  const roofColors = [0x5d6b7a, 0x8a4b3c, 0x4f5a4c, 0x6a5848];
  for (const sx of [-1, 1]) {
    let z = 4 + rand() * 4;
    while (z < ROAD_LENGTH - 8) {
      const w = 5 + rand() * 3;
      const d = 5 + rand() * 2;
      const h = 2.6 + rand() * 1.4;
      const house = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(d, h, w), lambert(houseColors[Math.floor(rand() * houseColors.length)]));
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      house.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 1.6, 4), lambert(roofColors[Math.floor(rand() * roofColors.length)]));
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(d / Math.max(w, d), 1, w / Math.max(w, d));
      roof.position.y = h + 0.8;
      roof.castShadow = true;
      house.add(roof);
      house.position.set(sx * (WALL_X + 1.6 + d / 2 + rand()), 0, z + w / 2);
      group.add(house);

      // 庭木
      if (rand() < 0.6) {
        const tree = makeTree(rand);
        tree.position.set(sx * (WALL_X + 0.9), 0, z + rand() * w);
        group.add(tree);
      }
      z += w + 1.5 + rand() * 3;
    }
  }

  // 電柱（石がぶつかる障害物）
  const poleMat = lambert(0x8e8a84);
  for (let z = 10, i = 0; z < ROAD_LENGTH - 6; z += 22 + rand() * 8, i++) {
    const sx = i % 2 === 0 ? 1 : -1;
    const px = sx * (WALL_X - 0.75 - 0.16);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 8, 8), poleMat);
    pole.position.set(px, 4, z);
    pole.castShadow = true;
    group.add(pole);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.08), poleMat);
    bar.position.set(px, 7.4, z);
    bar.castShadow = true;
    group.add(bar);
    poles.push({ x: px, z, radius: 0.16 });
  }

  return { group, poles };
}

function makeTree(rand: () => number): THREE.Group {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.4, 6), lambert(0x7a5b3e));
  trunk.position.y = 0.7;
  trunk.castShadow = true;
  tree.add(trunk);
  const s = 0.9 + rand() * 0.6;
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), lambert(rand() < 0.5 ? 0x6f8f4e : 0x7f9d55));
  leaves.position.y = 1.4 + s * 0.7;
  leaves.castShadow = true;
  tree.add(leaves);
  return tree;
}

function buildSchool(group: THREE.Group) {
  const school = new THREE.Mesh(new THREE.BoxGeometry(22, 7, 6), lambert(0xe6e0d2));
  school.position.set(0, 3.5, START_WALL_Z - 10);
  school.castShadow = true;
  group.add(school);
  const clock = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.1, 16), lambert(0xffffff));
  clock.rotation.x = Math.PI / 2;
  clock.position.set(0, 5.6, START_WALL_Z - 6.9);
  group.add(clock);
}

function buildHome(group: THREE.Group) {
  const home = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 6), lambert(0xf2e2c4));
  body.position.y = 1.6;
  body.castShadow = true;
  body.receiveShadow = true;
  home.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 1.8, 4), lambert(0xb5523b));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 4.1;
  roof.castShadow = true;
  home.add(roof);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.9, 1.0), lambert(0x7a5236));
  door.position.set(-3.01, 0.95, 0);
  home.add(door);
  home.position.set(WALL_X + 4.5, 0, HOME_GATE.z);
  group.add(home);

  // 門の前の目印（玄関マット風）
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(HOME_GATE.depth, HOME_GATE.halfWidth * 2), lambert(0xd9a35a));
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(HOME_GATE.x, 0.004, HOME_GATE.z);
  mat.receiveShadow = true;
  group.add(mat);

  // 門柱
  for (const dz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), lambert(0x8f8577));
    post.position.set(WALL_X + 0.1, 0.75, HOME_GATE.z + dz * (HOME_GATE.halfWidth + 0.2));
    post.castShadow = true;
    group.add(post);
  }
}

/** 石が家の前で止まったか */
export function isAtHome(x: number, z: number): boolean {
  return Math.abs(z - HOME_GATE.z) <= HOME_GATE.halfWidth && Math.abs(x - HOME_GATE.x) <= HOME_GATE.depth / 2;
}
