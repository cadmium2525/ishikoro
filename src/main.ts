import * as THREE from 'three';
import { buildWorld, HOME_GATE, isAtHome, ROAD_LENGTH } from './world';
import { Stone } from './stone';
import { Kid, KICK_OFFSET } from './kid';
import { KickInputController, OVERCHARGE_MAX, type KickInput } from './input';
import { AimGuide } from './aimGuide';
import { Sfx } from './audio';
import { clamp, damp, gaussian } from './rng';

type GameState = 'ready' | 'kicking' | 'rolling' | 'chasing' | 'arrived' | 'clear';

const FIXED_DT = 1 / 120;
/** 足が石に当たるまでの時間（キックモーションと合わせる） */
const KICK_CONTACT_DELAY = 0.1;
const START = { x: -0.6, z: 1.5 };
const STORAGE_KEY = 'ishikoro.records.v1';

// ---------- DOM ----------
const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const el = {
  dist: document.querySelector<HTMLElement>('#dist')!,
  kicks: document.querySelector<HTMLElement>('#kicks')!,
  power: document.querySelector<HTMLElement>('#power')!,
  powerFill: document.querySelector<HTMLElement>('#power .fill')!,
  spin: document.querySelector<HTMLElement>('#spin')!,
  spinDot: document.querySelector<HTMLElement>('#spin .dot')!,
  hint: document.querySelector<HTMLElement>('#hint')!,
  overlay: document.querySelector<HTMLElement>('#overlay')!,
  ovTitle: document.querySelector<HTMLElement>('#ov-title')!,
  ovBody: document.querySelector<HTMLElement>('#ov-body')!,
};

// ---------- three.js ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

const world = buildWorld(20260401);
scene.add(world.group);

const guide = new AimGuide();
scene.add(guide.group);

const sfx = new Sfx();
const input = new KickInputController(canvas);

// ---------- ゲーム状態 ----------
let state: GameState = 'ready';
let stone!: Stone;
let kid!: Kid;
let kicks = 0;
let stateTime = 0;
let pendingKick: { angle: number; power: number; spin: number } | null = null;
let hintShown = true;

const camFocus = new THREE.Vector3();
let camYaw = 0;
let camDist = 6;
let camHeight = 5;
/** 主人公が石を隠さないよう、右斜め後ろからの視点 */
const CAM_SIDE_ANGLE = 0.38;

interface Records {
  cleared: number;
  plays: number;
  bestKicks: number | null;
}
const records: Records = loadRecords();

function loadRecords(): Records {
  try {
    const r = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    if (r && typeof r.cleared === 'number') return r;
  } catch {
    /* 初回・破損時は初期値 */
  }
  return { cleared: 0, plays: 0, bestKicks: null };
}

function saveRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* プライベートモードなどでは保存しない */
  }
}

function newRun() {
  if (stone) scene.remove(stone.mesh);
  if (kid) scene.remove(kid.root);
  const seed = (Math.random() * 2 ** 31) | 0;
  stone = new Stone(seed, { onImpact: (s) => sfx.impact(s) });
  stone.place(START.x, START.z);
  scene.add(stone.mesh);

  kid = new Kid(seed ^ 0x5bd1e995);
  kid.heading = aimCenter();
  placeKidBehindStone(kid.heading);
  scene.add(kid.root);

  kicks = 0;
  records.plays++;
  saveRecords();
  el.overlay.classList.remove('on');
  camYaw = aimCenter();
  camFocus.copy(stone.position);
  enterReady();
}

/** 次のキックの基準方向。道の少し先、終盤は家の門を向く。 */
function aimCenter(): number {
  const p = stone.position;
  const tx = p.z > HOME_GATE.z - 12 ? HOME_GATE.x : 0;
  const tz = p.z > HOME_GATE.z - 12 ? HOME_GATE.z : p.z + 12;
  return Math.atan2(tx - p.x, tz - p.z);
}

/** 右足が石の真後ろに来る立ち位置 */
function kickSpot(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = stone.position;
  // 主人公のローカル +X（左手側）方向へ右足の分だけずらす
  const side = 0.09;
  return out.set(
    p.x - Math.sin(heading) * KICK_OFFSET + Math.cos(heading) * side,
    0,
    p.z - Math.cos(heading) * KICK_OFFSET - Math.sin(heading) * side,
  );
}

function placeKidBehindStone(heading: number) {
  kickSpot(heading, kid.position);
}

function enterReady() {
  state = 'ready';
  stateTime = 0;
  kid.setPose('idle');
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
el.overlay.addEventListener('pointerdown', () => {
  if (state === 'clear') newRun();
});

// ---------- 更新 ----------
const tmpTarget = new THREE.Vector3();

function fixedUpdate(dt: number) {
  stateTime += dt;
  input.update(dt);

  switch (state) {
    case 'ready': {
      const charging = input.phase === 'charge';
      const center = aimCenter();
      const aim = center + (charging ? input.lockedAim : input.sweep);
      // 狙い中は基準方向、構えたら確定した方向へ体を向ける
      kid.turnTo(charging ? aim : center, dt, charging ? 14 : 6);
      kid.moveToward(kickSpot(kid.heading, tmpTarget), 2, dt);
      kid.setPose(charging ? 'windup' : 'idle');
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
      stone.step(dt, world.poles);
      // 石を見守りながら少し後ろを付いていく
      const d = Math.hypot(stone.position.x - kid.position.x, stone.position.z - kid.position.z);
      if (stateTime > 0.35 && d > 2.2) {
        kid.setPose('run');
        kid.moveToward(stone.position, 3.2, dt);
      } else if (stateTime > 0.45) {
        kid.setPose('idle');
        kid.turnTo(Math.atan2(stone.position.x - kid.position.x, stone.position.z - kid.position.z), dt, 6);
      }
      if (!stone.moving) {
        state = isAtHome(stone.position.x, stone.position.z) ? 'arrived' : 'chasing';
        stateTime = 0;
      }
      break;
    }
    case 'chasing': {
      kid.setPose('run');
      const arrived = kid.moveToward(kickSpot(aimCenter(), tmpTarget), 4.2, dt);
      if (arrived) enterReady();
      break;
    }
    case 'arrived': {
      // 家の前の石まで歩いて行き、足元を見下ろす
      const target = tmpTarget.set(stone.position.x - 0.4, 0, stone.position.z);
      const there = kid.moveToward(target, 1.6, dt);
      kid.setPose(there ? 'idle' : 'walk');
      if (there) kid.turnTo(Math.PI / 2, dt, 5);
      if (stateTime > 2.2) showClear();
      break;
    }
    case 'clear':
      break;
  }
  kid.update(dt);
}

function showClear() {
  state = 'clear';
  records.cleared++;
  if (records.bestKicks === null || kicks < records.bestKicks) records.bestKicks = kicks;
  saveRecords();
  el.ovTitle.textContent = 'ただいま';
  el.ovBody.innerHTML =
    `今日の石を ${kicks} 回で連れて帰った。<br>` +
    `<span class="small">持ち帰った石 ${records.cleared} 個 ／ 最少 ${records.bestKicks} 回</span>`;
  el.overlay.classList.add('on');
}

function updateCamera(dt: number) {
  const portrait = camera.aspect < 1;
  const zoom = portrait ? 1.3 : 1;
  let focus: THREE.Vector3;
  let rate = 3;
  let dist = 5.4;
  let height = 5.4;
  let yaw = aimCenter() + CAM_SIDE_ANGLE;

  if (state === 'rolling') {
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
  } else if (state === 'arrived' || state === 'clear') {
    focus = tmpFocus.set(stone.position.x - 0.2, 0, stone.position.z);
    dist = 3.6;
    height = 2.6;
    rate = 1.5;
    yaw = Math.PI / 2 - 0.5;
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
  el.dist.textContent = String(Math.max(0, Math.round(HOME_GATE.z - stone.position.z)));
  el.kicks.textContent = String(kicks);
  const charging = state === 'ready' && input.phase === 'charge';
  el.power.classList.toggle('on', charging);
  el.spin.classList.toggle('on', charging);
  el.power.classList.toggle('over', input.power > 1);
  el.powerFill.style.height = `${clamp(input.power / OVERCHARGE_MAX, 0, 1) * 100}%`;
  el.spinDot.style.transform = `translateX(${input.spin * 10}px)`;
  guide.visible = state === 'ready';
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

newRun();
requestAnimationFrame(frame);

// デバッグ用（コンソールから石の性格を確認）
Object.assign(window, { ishikoro: { get stone() { return stone; }, ROAD_LENGTH } });
