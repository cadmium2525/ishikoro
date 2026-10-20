import * as THREE from 'three';
import { buildWorld } from './world';
import { carRoadAt, groundAt, hazardAt, isAtHome, routePoint, routeProgress, ROUTE_LENGTH, sidewalkAt, START } from './level';
import { Stone } from './stone';
import { Kid, KICK_OFFSET } from './kid';
import { KickInputController, OVERCHARGE_MAX, type KickInput } from './input';
import { AimGuide } from './aimGuide';
import { Traffic } from './traffic';
import { Sfx } from './audio';
import { clamp, damp, gaussian } from './rng';

type GameState = 'title' | 'ready' | 'kicking' | 'rolling' | 'chasing' | 'arrived' | 'clear' | 'lost' | 'over';
type LostReason = 'gutter' | 'grass' | 'grate' | 'car';

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
};

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
scene.add(new THREE.HemisphereLight(0xfff1d6, 0x8a7a5c, 1.4));
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
const SUN_OFFSET = new THREE.Vector3(-14, 11, -6);
scene.add(sun, sun.target);

scene.add(buildWorld(20260401));

const traffic = new Traffic();
scene.add(traffic.group);

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
let lostReason: LostReason = 'gutter';
/** 今回の下校で石が進んだ最長の道のり */
let bestProgress = 0;
/** 子どもが車道の手前で待っている理由 */
let waitingFor: 'signal' | 'car' | null = null;

const camFocus = new THREE.Vector3();
let camYaw = 0;
let camDist = 6;
let camHeight = 5;
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
}
const records: Records = loadRecords();

function loadRecords(): Records {
  const base: Records = { cleared: 0, plays: 0, bestKicks: null, longest: 0 };
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

function spawnStoneAndKid() {
  if (stone) scene.remove(stone.mesh);
  if (kid) scene.remove(kid.root);
  const seed = (Math.random() * 2 ** 31) | 0;
  stone = new Stone(seed, { onImpact: (s) => sfx.impact(s) });
  stone.place(START.x, START.z);
  scene.add(stone.mesh);

  kid = new Kid(seed ^ 0x5bd1e995);
  kid.heading = aimCenter();
  kickSpot(kid.heading, kid.position);
  scene.add(kid.root);
  camYaw = aimCenter() + CAM_SIDE_ANGLE;
  camFocus.copy(stone.position);
}

function newRun() {
  spawnStoneAndKid();
  traffic.reset();
  kicks = 0;
  bestProgress = 0;
  records.plays++;
  saveRecords();
  el.overlay.classList.remove('on');
  el.status.classList.remove('off');
  el.hint.classList.toggle('off', !hintShown);
  enterReady();
}

/** 次のキックの基準方向。帰り道に沿って少し先を向く。 */
function aimCenter(): number {
  const p = stone.position;
  const [tx, tz] = routePoint(routeProgress(p.x, p.z) + AIM_LOOKAHEAD);
  if (Math.hypot(tx - p.x, tz - p.z) < 0.3) return kid ? kid.heading : 0;
  return Math.atan2(tx - p.x, tz - p.z);
}

/** 左足が石の真後ろに来る立ち位置 */
function kickSpot(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = stone.position;
  // 主人公のローカル -X（右手側）方向へ左足の分だけずらす
  const side = -0.09;
  return out.set(
    p.x - Math.sin(heading) * KICK_OFFSET + Math.cos(heading) * side,
    0,
    p.z - Math.cos(heading) * KICK_OFFSET - Math.sin(heading) * side,
  );
}

/**
 * 子どもを目標へ動かす。歩道を歩き、車道へ降りる前は信号・車を確認して待つ。
 * 子どもは車にひかれない（車は子どもに気づいて止まる）が、石には気づかない。
 */
function kidGo(target: THREE.Vector3, speed: number, dt: number): 'moving' | 'arrived' | 'waiting' {
  const p = kid.position;
  // 車道にある目標へは、まず今いる歩道の上を一番近いところまで歩いてから降りる
  let goal = target;
  const sw = sidewalkAt(p.x, p.z);
  if (sw && carRoadAt(target.x, target.z)) {
    const wx = clamp(target.x, sw.x0 + 0.25, sw.x1 - 0.25);
    const wz = clamp(target.z, sw.z0 + 0.25, sw.z1 - 0.25);
    // 近くまで来ていれば、そこから車道へ降りる（行き来して止まらないよう余裕を持たせる）
    if (Math.hypot(wx - p.x, wz - p.z) > 0.6) goal = tmpWaypoint.set(wx, 0, wz);
  }

  const dx = goal.x - p.x;
  const dz = goal.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.02) {
    const probe = Math.min(d, speed * dt + 0.3);
    const nx = p.x + (dx / d) * probe;
    const nz = p.z + (dz / d) * probe;
    const next = carRoadAt(nx, nz);
    if (next && next !== carRoadAt(p.x, p.z) && !traffic.mayCross(next, nx, nz, target.x, target.z)) {
      waitingFor = next.crossing === 'signal' ? 'signal' : 'car';
      kid.turnTo(Math.atan2(dx, dz), dt, 6);
      return 'waiting';
    }
  }
  waitingFor = null;
  const reached = kid.moveToward(goal, speed, dt);
  return reached && goal === target ? 'arrived' : 'moving';
}
const tmpWaypoint = new THREE.Vector3();

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
el.overlay.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sfx.unlock();
  if (state === 'title' || state === 'clear' || state === 'over') newRun();
});

// ---------- 更新 ----------
const tmpTarget = new THREE.Vector3();

/** 石が回収不能になったか調べる */
function checkLost(): boolean {
  const p = stone.position;
  const car = traffic.hitTest(p.x, p.z, p.y, stone.traits.radius);
  if (car) {
    const dir = car.lane.dir;
    stone.launch(dir * (car.speed * 0.8 + 1.5), 2.5 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5);
    sfx.thud();
    lose('car');
    return true;
  }
  if (!stone.onGround) return false;
  const h = hazardAt(p.x, p.z);
  if (!h) return false;
  if (h.kind === 'gutter') {
    stone.fallInto(h.rect);
    sfx.plop();
  } else {
    stone.sink();
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
  traffic.update(dt, state === 'title' ? null : kid.position);

  if (state !== 'title' && state !== 'lost' && state !== 'over' && state !== 'clear') {
    stone.step(dt, traffic.obstacles);
    if (checkLost()) {
      kid.update(dt);
      return;
    }
    bestProgress = Math.max(bestProgress, routeProgress(stone.position.x, stone.position.z));
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
      guide.update(stone.position, center, aim, input.power, input.spin, charging);
      break;
    }
    case 'kicking':
      if (pendingKick && stateTime >= KICK_CONTACT_DELAY) {
        stone.kick(pendingKick.angle, pendingKick.power, pendingKick.spin);
        sfx.kick(Math.min(1, pendingKick.power));
        pendingKick = null;
        kicks++;
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
        state = isAtHome(stone.position.x, stone.position.z) ? 'arrived' : 'chasing';
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
      const target = tmpTarget.set(stone.position.x, 0, stone.position.z - 0.45);
      const there = kidGo(target, 1.6, dt) === 'arrived';
      if (there) kid.turnTo(0, dt, 5);
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
  kid.position.y += (groundAt(kid.position.x, kid.position.z) - kid.position.y) * damp(18, dt);
}

function recordProgress() {
  records.longest = Math.max(records.longest, Math.round(bestProgress));
}

function showClear() {
  state = 'clear';
  records.cleared++;
  bestProgress = ROUTE_LENGTH;
  recordProgress();
  if (records.bestKicks === null || kicks < records.bestKicks) records.bestKicks = kicks;
  saveRecords();
  showOverlay('ただいま', `今日の石を ${kicks} 回で連れて帰った。`, 'タップでもう一度');
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
    `<span class="small">持ち帰った石 ${records.cleared} 個（${rate}%）` +
    (records.bestKicks !== null ? ` ／ 最少 ${records.bestKicks} 回` : '') +
    ` ／ 最長 ${records.longest} m</span>`
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
    focus = tmpFocus.set(stone.position.x, 0, stone.position.z + 0.3);
    dist = 3.4;
    height = 2.6;
    rate = 1.5;
    yaw = 0.5;
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

  camera.position.set(camFocus.x - Math.sin(camYaw) * camDist, camHeight, camFocus.z - Math.cos(camYaw) * camDist);
  camera.lookAt(camFocus.x, 0.3, camFocus.z);

  sun.position.copy(camFocus).add(SUN_OFFSET);
  sun.target.position.copy(camFocus);
}
const tmpFocus = new THREE.Vector3();

function updateHud() {
  const s = routeProgress(stone.position.x, stone.position.z);
  el.dist.textContent = String(Math.max(0, Math.round(ROUTE_LENGTH - s)));
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
  guide.group.position.y = groundAt(stone.position.x, stone.position.z) + 0.01;
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

// タイトル：通学路の風景の上に案内を出す
spawnStoneAndKid();
traffic.reset();
el.status.classList.add('off');
el.hint.classList.add('off');
showOverlay('いしころ', '今日の石を、家まで連れて帰ろう。', 'タップで はじめる');
requestAnimationFrame(frame);

// デバッグ用（コンソールから石の性格や状態を確認）
Object.assign(window, {
  ishikoro: {
    get stone() { return stone; },
    get kid() { return kid; },
    get state() { return state; },
    traffic,
    input,
    /** 石が止まった直後の状態にする（自動テスト用） */
    chase() { input.disable(); state = 'chasing'; stateTime = 0; },
  },
});
