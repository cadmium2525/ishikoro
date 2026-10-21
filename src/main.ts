import * as THREE from 'three';
import { buildWorld, disposeWorld, type Occluder } from './world';
import { Level } from './level';
import { Stone, stoneName } from './stone';
import { addToCollection, showCollection } from './collection';
import { Kid, KICK_OFFSET } from './kid';
import { KickInputController, OVERCHARGE_MAX, type KickInput } from './input';
import { AimGuide } from './aimGuide';
import { Traffic } from './traffic';
import { Walkers } from './walkers';
import { Sfx } from './audio';
import { clamp, damp, gaussian } from './rng';

type GameState = 'title' | 'ready' | 'kicking' | 'rolling' | 'chasing' | 'arrived' | 'clear' | 'lost' | 'over';
type LostReason = 'gutter' | 'grass' | 'grate' | 'water' | 'manhole' | 'car' | 'person' | 'dog' | 'cat';

const FIXED_DT = 1 / 120;
/** 足が石に当たるまでの時間（キックモーションと合わせる） */
const KICK_CONTACT_DELAY = 0.1;
/** キックの基準方向を決めるとき、帰り道のどれだけ先を見るか [m] */
const AIM_LOOKAHEAD = 8;
const STORAGE_KEY = 'ishikoro.records.v1';

const LOST_TEXT: Record<LostReason, string> = {
  gutter: '石が側溝に落ちてしまった。',
  grass: '石が草むらに消えてしまった。',
  grate: '石が集水ますの格子にはまってしまった。',
  water: '石が田んぼに落ちてしまった。',
  manhole: '石が工事中のマンホールに落ちてしまった。',
  person: '石が通りがかりの人に当たってしまった。',
  dog: '石が散歩中の犬に当たってしまった。',
  cat: '石がねこに当たってしまった。',
  car: '石が車にはじかれてしまった。',
};

// ---------- DOM ----------
const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const el = {
  status: document.querySelector<HTMLElement>('#status')!,
  dist: document.querySelector<HTMLElement>('#dist')!,
  kicks: document.querySelector<HTMLElement>('#kicks')!,
  msg: document.querySelector<HTMLElement>('#msg')!,
  power: document.querySelector<HTMLElement>('#power')!,
  powerFill: document.querySelector<HTMLElement>('#power .fill')!,
  spin: document.querySelector<HTMLElement>('#spin')!,
  spinDot: document.querySelector<HTMLElement>('#spin .dot')!,
  hint: document.querySelector<HTMLElement>('#hint')!,
  overlay: document.querySelector<HTMLElement>('#overlay')!,
  ovTitle: document.querySelector<HTMLElement>('#ov-title')!,
  ovBody: document.querySelector<HTMLElement>('#ov-body')!,
  ovAction: document.querySelector<HTMLElement>('#ov-action')!,
  toast: document.querySelector<HTMLElement>('#toast')!,
  ovCollection: document.querySelector<HTMLElement>('#ov-collection')!,
  collection: document.querySelector<HTMLElement>('#collection')!,
  collectionGrid: document.querySelector<HTMLElement>('#collection-grid')!,
  collectionClose: document.querySelector<HTMLElement>('#collection-close')!,
};

let toastTimer = 0;
/** 画面上部に数秒だけ出るお知らせ */
function showToast(text: string) {
  el.toast.textContent = text;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('on'), 3500);
}

// ---------- three.js ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// 高解像度スマホでは描画負荷が跳ね上がるので上限を抑える
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0xf6dcae);
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor, 30, 70);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);

// 午後の斜光：低い位置からの暖色光と長い影
const hemi = new THREE.HemisphereLight(0xfff1d6, 0x8a7a5c, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffd59a, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

/** その日の通学路と、そこを走る車 */
let level!: Level;
let worldGroup: THREE.Group | null = null;
let traffic!: Traffic;
/** 通行人・散歩の犬・ねこ */
let walkers!: Walkers;

const guide = new AimGuide();
scene.add(guide.group);

const sfx = new Sfx();
const input = new KickInputController(canvas);

// ---------- ゲーム状態 ----------
let state: GameState = 'title';
let stone!: Stone;
let kid!: Kid;
let kicks = 0;
let stateTime = 0;
let pendingKick: { angle: number; power: number; spin: number } | null = null;
let hintShown = true;
/** 今日の石の種（コレクションに残す） */
let stoneSeed = 0;
let lostReason: LostReason = 'gutter';
/** 今回の下校で石が進んだ最長の道のり */
let bestProgress = 0;
/** 子どもが車道の手前で待っている理由 */
let waitingFor: 'signal' | 'car' | null = null;

const camFocus = new THREE.Vector3();
let camYaw = 0;
let camDist = 6;
let camHeight = 5;
let camLookY = 0.3;
/**
 * 車道側の斜め後ろからの視点。歩道の先と、迫ってくる車を同時に見せる。
 * 主人公は左足で蹴るので、カメラ側に体がかぶらない。
 */
const CAM_SIDE_ANGLE = -0.38;

interface Records {
  cleared: number;
  plays: number;
  bestKicks: number | null;
  /** 最長の下校距離 [m] */
  longest: number;
  /** これまでに蹴った回数 */
  totalKicks: number;
}
const records: Records = loadRecords();

function loadRecords(): Records {
  const base: Records = { cleared: 0, plays: 0, bestKicks: null, longest: 0, totalKicks: 0 };
  try {
    const r = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    if (r && typeof r.cleared === 'number') return { ...base, ...r };
  } catch {
    /* 初回・破損時は初期値 */
  }
  return base;
}

function saveRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* プライベートモードなどでは保存しない */
  }
}

/** その日の空模様。毎回ちがう下校の時間帯になる */
const SKIES = [
  { name: 'ひるさがり', sky: 0xf6dcae, sun: 0xffd59a, sunI: 2.2, hemi: 1.4, offset: new THREE.Vector3(-14, 11, -6) },
  { name: 'ゆうがた', sky: 0xf2b48a, sun: 0xff9a62, sunI: 2.0, hemi: 1.15, offset: new THREE.Vector3(-16, 6.5, -9) },
  { name: 'くもり', sky: 0xd9d9d2, sun: 0xf4f1ea, sunI: 0.9, hemi: 2.0, offset: new THREE.Vector3(-8, 14, -4) },
];
let sunOffset = SKIES[0].offset;
let daySky = SKIES[0].name;

/** 新しい一日：通学路・車・空・主人公・石を作り直す */
function setupDay(daySeed: number) {
  if (stone) scene.remove(stone.mesh);
  if (kid) {
    scene.remove(kid.root);
    kid.dispose();
  }
  if (stone) stone.dispose();
  if (worldGroup) {
    scene.remove(worldGroup);
    disposeWorld(worldGroup);
  }
  if (traffic) {
    scene.remove(traffic.group);
    traffic.dispose();
  }
  if (walkers) {
    scene.remove(walkers.group);
    walkers.dispose();
  }
  level = new Level(daySeed);
  worldGroup = buildWorld(level);
  scene.add(worldGroup);
  traffic = new Traffic(level);
  scene.add(traffic.group);
  traffic.reset();
  walkers = new Walkers(level);
  scene.add(walkers.group);
  walkers.reset(0);

  const sky = SKIES[Math.abs(daySeed) % SKIES.length];
  skyColor.setHex(sky.sky);
  (scene.fog as THREE.Fog).color.setHex(sky.sky);
  sun.color.setHex(sky.sun);
  sun.intensity = sky.sunI;
  hemi.intensity = sky.hemi;
  sunOffset = sky.offset;
  daySky = sky.name;

  stoneSeed = (daySeed ^ 0x6a09e667) >>> 0;
  stone = new Stone(stoneSeed, level, { onImpact: (s) => sfx.impact(s) });
  stone.place(level.start.x, level.start.z);
  scene.add(stone.mesh);

  kid = new Kid(daySeed ^ 0x5bd1e995);
  kid.heading = aimCenter();
  kickSpot(kid.heading, kid.position);
  kid.position.y = level.groundAt(kid.position.x, kid.position.z);
  scene.add(kid.root);
  camYaw = aimCenter() + CAM_SIDE_ANGLE;
  camFocus.copy(stone.position);
}

const newDaySeed = () => (Math.random() * 2 ** 31) | 0;

/** fresh なら新しい一日を作る。タイトルからは、背景に見えていたその日の道で始める */
function newRun(fresh: boolean) {
  if (fresh) setupDay(newDaySeed());
  kicks = 0;
  bestProgress = 0;
  records.plays++;
  saveRecords();
  el.overlay.classList.remove('on');
  el.status.classList.remove('off');
  el.hint.classList.toggle('off', !hintShown);
  showToast(`きょうの石：${stoneName(stone.traits)}`);
  enterReady();
}

/** 次のキックの基準方向。帰り道に沿って少し先を向く。 */
function aimCenter(): number {
  const p = stone.position;
  const [tx, tz] = level.routePoint(level.routeProgress(p.x, p.z) + AIM_LOOKAHEAD);
  if (Math.hypot(tx - p.x, tz - p.z) < 0.3) return kid ? kid.heading : 0;
  return Math.atan2(tx - p.x, tz - p.z);
}

/** 左足が石の真後ろに来る立ち位置 */
function kickSpot(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = stone.position;
  // 主人公のローカル -X（右手側）方向へ左足の分だけずらす
  const side = -0.09;
  out.set(
    p.x - Math.sin(heading) * KICK_OFFSET + Math.cos(heading) * side,
    0,
    p.z - Math.cos(heading) * KICK_OFFSET - Math.sin(heading) * side,
  );
  // 塀ぎわの石では、立ち位置が塀の向こうにならないよう石の側へ寄せてから、塀にめり込まない位置に立つ
  if (!level.clearPath(p.x, p.z, out.x, out.z)) out.set(p.x + (out.x - p.x) * 0.2, 0, p.z + (out.z - p.z) * 0.2);
  level.pushOutCircle(out, KID_RADIUS);
  return out;
}

/** 子どもの体の半径（塀や電柱にめり込まないように） */
const KID_RADIUS = 0.22;

/**
 * 子どもを目標へ動かす。歩道を歩き、車道へ降りる前は信号・車を確認して待つ。
 * 子どもは車にひかれない（車は子どもに気づいて止まる）が、石には気づかない。
 */
function kidGo(target: THREE.Vector3, speed: number, dt: number): 'moving' | 'arrived' | 'waiting' {
  const p = kid.position;
  // 車道にある目標へは、まず今いる歩道の上を一番近いところまで歩いてから降りる
  let goal = target;
  const sw = level.sidewalkAt(p.x, p.z);
  if (sw && level.carRoadAt(target.x, target.z)) {
    const wx = clamp(target.x, sw.x0 + 0.25, sw.x1 - 0.25);
    const wz = clamp(target.z, sw.z0 + 0.25, sw.z1 - 0.25);
    // 近くまで来ていれば、そこから車道へ降りる（行き来して止まらないよう余裕を持たせる）
    if (Math.hypot(wx - p.x, wz - p.z) > 0.6) goal = tmpWaypoint.set(wx, 0, wz);
  }
  // 塀にさえぎられて真っすぐ行けないときは、帰り道に沿って回り込む
  if (!level.clearPath(p.x, p.z, goal.x, goal.z)) {
    const s0 = level.routeProgress(p.x, p.z);
    const s1 = level.routeProgress(goal.x, goal.z);
    const [rx, rz] = level.routePoint(s0 + Math.sign(s1 - s0) * 2);
    goal = tmpDetour.set(rx, 0, rz);
  }

  const dx = goal.x - p.x;
  const dz = goal.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.02) {
    const probe = Math.min(d, speed * dt + 0.3);
    const nx = p.x + (dx / d) * probe;
    const nz = p.z + (dz / d) * probe;
    const next = level.carRoadAt(nx, nz);
    if (next && next !== level.carRoadAt(p.x, p.z) && !traffic.mayCross(next, nx, nz, target.x, target.z)) {
      waitingFor = level.signalFor(next, nx, nz) >= 0 ? 'signal' : 'car';
      kid.turnTo(Math.atan2(dx, dz), dt, 6);
      return 'waiting';
    }
  }
  waitingFor = null;
  const reached = kid.moveToward(goal, speed, dt);
  level.pushOutCircle(p, KID_RADIUS);
  return reached && goal === target ? 'arrived' : 'moving';
}
const tmpWaypoint = new THREE.Vector3();
const tmpDetour = new THREE.Vector3();

function enterReady() {
  state = 'ready';
  stateTime = 0;
  kid.setPose('move');
  input.enable();
}

input.onKick = (k: KickInput) => {
  sfx.unlock();
  const center = aimCenter();
  // 蹴りすぎると狙いがぶれ、想定以上に飛ぶ
  const over = Math.max(0, k.power - 1) / (OVERCHARGE_MAX - 1);
  const angle = center + k.aimOffset + gaussian() * (0.012 + over * 0.2);
  const power = k.power > 1 ? 1 + over * (0.08 + Math.random() * 0.15) : k.power;
  pendingKick = { angle, power: Math.max(0.03, power), spin: k.spin };
  kid.setWindup(Math.min(1, k.power));
  kid.setPose('kick');
  state = 'kicking';
  stateTime = 0;
  if (hintShown) {
    hintShown = false;
    el.hint.classList.add('off');
  }
};

canvas.addEventListener('pointerdown', () => sfx.unlock());
// コレクション：結果画面のボタンから開く（画面のタップで次へ進まないように止める）
el.ovCollection.addEventListener('pointerdown', (e) => e.stopPropagation());
el.ovCollection.addEventListener('click', () => showCollection(el.collection, el.collectionGrid, level));
el.collectionClose.addEventListener('click', () => el.collection.classList.remove('on'));

el.overlay.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sfx.unlock();
  if (state === 'title') newRun(false);
  else if (state === 'clear' || state === 'over') newRun(true);
});

// ---------- 更新 ----------
const tmpTarget = new THREE.Vector3();

/** 石が回収不能になったか調べる */
function checkLost(): boolean {
  const p = stone.position;
  const car = traffic.hitTest(p.x, p.z, p.y, stone.traits.radius);
  if (car) {
    // 車の進む向きにはじかれる
    const push = car.lane.dir * (car.speed * 0.8 + 1.5);
    const side = (Math.random() - 0.5) * 1.5;
    const up = 2.5 + Math.random() * 1.5;
    if (car.lane.axis === 'x') stone.launch(push, up, side);
    else stone.launch(side, up, push);
    sfx.thud();
    lose('car');
    return true;
  }
  // 通行人・犬・ねこに当たったら跳ね返って、その日はおしまい
  if (stone.moving && stone.horizontalSpeed > 0.25) {
    const who = walkers.hitTest(p.x, p.z, p.y, stone.traits.radius);
    if (who) {
      stone.velocity.x *= -0.3;
      stone.velocity.z *= -0.3;
      sfx.thud();
      lose(who);
      return true;
    }
  }
  if (!stone.onGround) return false;
  const h = level.hazardAt(p.x, p.z);
  if (!h) return false;
  if (h.kind === 'grass') {
    stone.sink();
  } else {
    // 側溝・集水ます・田んぼ：縁から落ちて沈む
    stone.fallInto(h.rect);
    sfx.plop();
  }
  lose(h.kind);
  return true;
}

function lose(reason: LostReason) {
  lostReason = reason;
  state = 'lost';
  stateTime = 0;
  input.disable();
  waitingFor = null;
}

function fixedUpdate(dt: number) {
  stateTime += dt;
  input.update(dt);
  const peds = walkers.pedestrians;
  traffic.update(dt, state === 'title' ? peds : [kid.position, ...peds]);
  if (state !== 'over' && state !== 'clear') walkers.update(dt, stone.position, stone.moving, kid.position, traffic);

  if (state !== 'title' && state !== 'lost' && state !== 'over' && state !== 'clear') {
    stone.step(dt, traffic.obstacles);
    if (checkLost()) {
      kid.update(dt);
      return;
    }
    bestProgress = Math.max(bestProgress, level.routeProgress(stone.position.x, stone.position.z));
  }

  switch (state) {
    case 'ready': {
      const charging = input.phase === 'charge';
      const center = aimCenter();
      const aim = center + (charging ? input.lockedAim : input.sweep);
      // 狙い中は基準方向、構えたら確定した方向へ体を向ける
      kid.turnTo(charging ? aim : center, dt, charging ? 14 : 6);
      kidGo(kickSpot(kid.heading, tmpTarget), 2, dt);
      kid.setPose(charging ? 'windup' : 'move');
      kid.setWindup(Math.min(1, input.power));
      guide.update(stone.position, center, aim, input.power, input.spin, charging, (x, z) => level.groundAt(x, z));
      break;
    }
    case 'kicking':
      if (pendingKick && stateTime >= KICK_CONTACT_DELAY) {
        stone.kick(pendingKick.angle, pendingKick.power, pendingKick.spin);
        sfx.kick(Math.min(1, pendingKick.power));
        pendingKick = null;
        kicks++;
        records.totalKicks++;
        state = 'rolling';
        stateTime = 0;
      }
      break;
    case 'rolling': {
      // 石を見守りながら少し後ろを付いていく（近づくと減速するので止まり際もなめらか）
      const dx = stone.position.x - kid.position.x;
      const dz = stone.position.z - kid.position.z;
      const d = Math.hypot(dx, dz);
      if (stateTime > 0.35 && d > 1.9) {
        kidGo(tmpTarget.set(stone.position.x - (dx / d) * 1.8, 0, stone.position.z - (dz / d) * 1.8), 3.4, dt);
      } else if (stateTime > 0.45) {
        kid.turnTo(Math.atan2(dx, dz), dt, 6);
      }
      if (!stone.moving) {
        state = level.isAtHome(stone.position.x, stone.position.z) ? 'arrived' : 'chasing';
        stateTime = 0;
      }
      break;
    }
    case 'chasing': {
      if (kidGo(kickSpot(aimCenter(), tmpTarget), 4.2, dt) === 'arrived') enterReady();
      break;
    }
    case 'arrived': {
      // 家の前の石まで歩いて行き、足元を見下ろす
      const h = level.home;
      const target = tmpTarget.set(stone.position.x - h.nx * 0.45, 0, stone.position.z - h.nz * 0.45);
      const there = kidGo(target, 1.6, dt) === 'arrived';
      if (there) kid.turnTo(Math.atan2(h.nx, h.nz), dt, 5);
      if (stateTime > 2.4) showClear();
      break;
    }
    case 'lost': {
      // その場で立ち止まり、石の行方を見る
      stone.step(dt);
      kid.turnTo(Math.atan2(stone.position.x - kid.position.x, stone.position.z - kid.position.z), dt, 4);
      if (stateTime > 2.6) showGameOver();
      break;
    }
  }
  kid.update(dt);
  // 歩道の段差を上り下りする
  kid.position.y += (level.groundAt(kid.position.x, kid.position.z) - kid.position.y) * damp(18, dt);
}

function recordProgress() {
  records.longest = Math.max(records.longest, Math.round(bestProgress));
}

function showClear() {
  state = 'clear';
  records.cleared++;
  bestProgress = level.routeLength;
  recordProgress();
  if (records.bestKicks === null || kicks < records.bestKicks) records.bestKicks = kicks;
  saveRecords();
  const name = stoneName(stone.traits);
  addToCollection({
    seed: stoneSeed,
    name,
    date: new Date().toISOString(),
    kicks,
    distance: Math.round(level.routeLength),
    difficulty: level.difficulty,
  });
  showOverlay('ただいま', `「${name}」を ${kicks} 回で連れて帰った。`, 'タップで次の日へ');
}

function showGameOver() {
  state = 'over';
  recordProgress();
  saveRecords();
  showOverlay('きょうは ここまで', `${LOST_TEXT[lostReason]}<br>${Math.round(bestProgress)} m 進んだ。`, 'タップで次の日へ');
}

function recordsLine() {
  const rate = records.plays ? Math.round((records.cleared / records.plays) * 100) : 0;
  return (
    `<span class="small">持ち帰った石 ${records.cleared} 個（${rate}%）／ 最長 ${records.longest} m` +
    ` ／ これまで ${records.totalKicks} 回けった</span>`
  );
}

/** その日の道のようす（タイトルに出す） */
function dayLine() {
  const turns = level.turns === 0 ? 'まっすぐ' : `${level.turns}回まがる`;
  const extra = [turns, level.crossings ? `横断歩道 ${level.crossings}` : '', level.slopes.length ? '坂あり' : ''].filter(Boolean).join('・');
  return (
    `<div class="day">きょうの みち：${level.difficultyLabel}・やく ${Math.round(level.routeLength)} m・${daySky}<br>` +
    `<span class="small">${extra}</span></div>`
  );
}

function showOverlay(title: string, body: string, action: string) {
  el.ovTitle.textContent = title;
  el.ovBody.innerHTML = `${body}<br>${recordsLine()}`;
  el.ovAction.textContent = action;
  el.overlay.classList.add('on');
  el.overlay.classList.toggle('title', state === 'title');
}

function updateCamera(dt: number) {
  const portrait = camera.aspect < 1;
  const zoom = portrait ? 1.3 : 1;
  let focus: THREE.Vector3;
  let rate = 3;
  let dist = 5.4;
  let height = 5.4;
  let yaw = aimCenter() + CAM_SIDE_ANGLE;

  if (state === 'title') {
    // 学校の前から通学路を見渡す
    focus = tmpFocus.set(1.5, 0, 12);
    dist = 12;
    height = 7;
    rate = 1;
    yaw = 0.5 + Math.sin(performance.now() / 4000) * 0.15;
  } else if (state === 'rolling') {
    // 転がる石を追う。速いほど引いて先を見せる
    const v = stone.velocity;
    const speed = stone.horizontalSpeed;
    focus = tmpFocus.set(stone.position.x + v.x * 0.3, 0, stone.position.z + v.z * 0.3);
    dist = 5.5 + speed * 0.4;
    height = 5 + speed * 0.45;
    rate = 4;
    yaw = camYaw;
  } else if (state === 'kicking') {
    focus = tmpFocus.copy(stone.position);
    yaw = camYaw;
  } else if (state === 'lost' || state === 'over') {
    focus = tmpFocus.set(stone.position.x, 0, stone.position.z);
    dist = 6;
    height = 5;
    rate = 2;
    yaw = camYaw;
  } else if (state === 'arrived' || state === 'clear') {
    // 家を背景に、足元の石を見下ろす
    const h = level.home;
    focus = tmpFocus.set(stone.position.x + h.nx * 0.3, 0, stone.position.z + h.nz * 0.3);
    dist = 3.4;
    height = 2.6;
    rate = 1.5;
    yaw = Math.atan2(h.nx, h.nz) + 0.5;
  } else if (waitingFor) {
    // 車道の手前で待っている間は、子どもと石と信号・車を一緒に見せる
    focus = tmpFocus.set((stone.position.x + kid.position.x) / 2, 0, (stone.position.z + kid.position.z) / 2 + 1);
    dist = 7;
    height = 6.5;
    rate = 2;
  } else {
    // キック前・追いかけ中：主人公と石と前方の道
    // 画面上で石が真下に来るよう、カメラの向きに沿って先を見る
    focus = tmpFocus.set(stone.position.x + Math.sin(yaw) * 2.4, 0, stone.position.z + Math.cos(yaw) * 2.4);
    rate = state === 'chasing' ? 2 : 3;
  }

  const k = damp(rate, dt);
  camFocus.lerp(focus, k);
  let dy = yaw - camYaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  camYaw += dy * damp(1.5, dt);
  camDist += (dist * zoom - camDist) * k;
  camHeight += (height * zoom - camHeight) * k;

  // 坂の上では見る高さも上げる
  const lookY = 0.3 + level.terrainAt(camFocus.x, camFocus.z);
  camLookY += (lookY - camLookY) * damp(3, dt);

  // 建物や木が子どもと石をさえぎるなら、真上から見る向きへ持ち上げる
  const occ = (worldGroup?.userData.occluders ?? []) as Occluder[];
  let need = 1;
  for (let k = 0; k <= 6; k++) {
    placeCamera(k / 6, tmpCam);
    const blocked = occ.some(
      (o) =>
        Math.abs((o.x0 + o.x1) / 2 - camFocus.x) < 30 &&
        Math.abs((o.z0 + o.z1) / 2 - camFocus.z) < 30 &&
        (segmentHitsBox(tmpCam, stone.position, o) || segmentHitsBox(tmpCam, tmpHead.copy(kid.position).setY(kid.position.y + 1.1), o)),
    );
    if (!blocked) {
      need = k / 6;
      break;
    }
  }
  camLift += (need - camLift) * damp(need > camLift ? 6 : 1.2, dt);
  placeCamera(camLift, camera.position);
  camera.lookAt(camFocus.x, camLookY, camFocus.z);

  sun.position.copy(camFocus).add(sunOffset);
  sun.target.position.copy(camFocus);
}
const tmpFocus = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpHead = new THREE.Vector3();
/** 視線がさえぎられたときの持ち上げ具合（0：ふだん、1：ほぼ真上） */
let camLift = 0;

/** lift だけ真上寄りにしたカメラ位置 */
function placeCamera(lift: number, out: THREE.Vector3) {
  const dist = camDist * (1 - 0.8 * lift);
  const height = camHeight * (1 + 0.25 * lift);
  return out.set(camFocus.x - Math.sin(camYaw) * dist, height + camLookY - 0.3, camFocus.z - Math.cos(camYaw) * dist);
}

/** 線分 a→b が箱（上から見た範囲・地面から top まで）を通るか */
function segmentHitsBox(a: THREE.Vector3, b: THREE.Vector3, o: Occluder): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: [number, number, number, number][] = [
    [a.x, b.x - a.x, o.x0, o.x1],
    [a.y, b.y - a.y, 0, o.top],
    [a.z, b.z - a.z, o.z0, o.z1],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let u0 = (lo - p) / d;
    let u1 = (hi - p) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0);
    t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}

function updateHud() {
  const s = level.routeProgress(stone.position.x, stone.position.z);
  const home = state === 'arrived' || state === 'clear';
  el.dist.textContent = home ? '0' : String(Math.max(0, Math.round(level.routeLength - s)));
  el.kicks.textContent = String(kicks);
  const charging = state === 'ready' && input.phase === 'charge';
  el.power.classList.toggle('on', charging);
  el.spin.classList.toggle('on', charging);
  el.power.classList.toggle('over', input.power > 1);
  el.powerFill.style.height = `${clamp(input.power / OVERCHARGE_MAX, 0, 1) * 100}%`;
  el.spinDot.style.transform = `translateX(${input.spin * 10}px)`;
  guide.visible = state === 'ready';

  const msg = waitingFor === 'signal' ? 'しんごう まち' : waitingFor === 'car' ? 'くるまが いくのを まつ' : '';
  if (el.msg.textContent !== msg) el.msg.textContent = msg;
  el.msg.classList.toggle('on', msg !== '');

  if (state !== 'title') traffic.updateWarnings(stone.position.x, stone.position.z);
  // 走行音：見ている場所の近くを車が通るほど大きく
  sfx.setTraffic(Math.max(0.12, 1 - traffic.nearestCar(camFocus.x, camFocus.z) / 18));
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let acc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  while (acc >= FIXED_DT) {
    fixedUpdate(FIXED_DT);
    acc -= FIXED_DT;
  }
  updateCamera(dt);
  updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// タイトル：その日の通学路の風景の上に案内を出す
setupDay(newDaySeed());
el.status.classList.add('off');
el.hint.classList.add('off');
showOverlay('いしころ', `今日の石を、家まで連れて帰ろう。${dayLine()}`, 'タップで はじめる');
requestAnimationFrame(frame);

// デバッグ用（コンソールから石の性格や状態を確認）
Object.assign(window, {
  ishikoro: {
    get stone() { return stone; },
    get kid() { return kid; },
    get state() { return state; },
    get level() { return level; },
    /** 指定した種で新しい一日を始める（自動テスト用） */
    day(seed: number) { setupDay(seed); newRun(false); },
    get traffic() { return traffic; },
    get walkers() { return walkers; },
    input,
    /** 石が止まった直後の状態にする（自動テスト用） */
    chase() { input.disable(); state = 'chasing'; stateTime = 0; },
  },
});
