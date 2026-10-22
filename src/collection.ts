import * as THREE from 'three';
import { STONE_KINDS, Stone, describeStone } from './stone';
import type { Level } from './level';

/** 持ち帰った石の記録 */
export interface CollectedStone {
  seed: number;
  name: string;
  /** 石の種類（古い記録にはない） */
  kind?: string;
  /** 持ち帰った日（ISO 形式の日付） */
  date: string;
  kicks: number;
  distance: number;
  difficulty: string;
}

const KEY = 'ishikoro.collection.v1';
const MAX = 80;

export function loadCollection(): CollectedStone[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addToCollection(entry: CollectedStone) {
  const list = loadCollection();
  list.unshift(entry);
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 保存できない環境では記録しない */
  }
}

/** 石の小さな肖像画。小さな描画器を1つだけ作って使い回す */
class Thumbnailer {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 10);
  private readonly cache = new Map<number, string>();

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xfff1d6, 0x8a7a5c, 1.6));
    const sun = new THREE.DirectionalLight(0xffe2b0, 2.2);
    sun.position.set(-1, 2, 1.5);
    this.scene.add(sun);
    this.camera.position.set(0, 0.35, 0.75);
    this.camera.lookAt(0, 0, 0);
  }

  get(seed: number, level: Level): string {
    const hit = this.cache.get(seed);
    if (hit) return hit;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setSize(112, 112, false);
    }
    const stone = new Stone(seed, level);
    stone.mesh.position.set(0, 0, 0);
    // 寝かせた石を少しこちらへ傾けて、形と模様が見えるように
    stone.mesh.rotation.x += 0.7;
    // 大きさの違いがわかるよう、カメラは固定
    this.scene.add(stone.mesh);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.scene.remove(stone.mesh);
    stone.dispose();
    this.cache.set(seed, url);
    return url;
  }
}

const thumbs = new Thumbnailer();

/** 石の肖像（data URL） */
export const stoneThumb = (seed: number, level: Level) => thumbs.get(seed, level);

/** コレクション画面を開く */
export function showCollection(panel: HTMLElement, grid: HTMLElement, level: Level) {
  const list = loadCollection();
  grid.textContent = '';
  // 名前・種類は種から決まる。古い記録も今の石の姿にそろえる
  const described = list.map((s) => describeStone(s.seed));
  const found = new Set(described.map((d) => d.kind.id));
  const count = document.createElement('p');
  count.className = 'kinds';
  count.textContent = `見つけた種類 ${found.size} / ${STONE_KINDS.length}`;
  grid.appendChild(count);
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'まだ石を持ち帰っていない。';
    grid.appendChild(empty);
  }
  list.forEach((s, i) => {
    const d = described[i];
    const card = document.createElement('div');
    card.className = 'stone-card';
    const img = document.createElement('img');
    img.alt = d.name;
    img.src = thumbs.get(s.seed, level);
    const name = document.createElement('div');
    name.className = 'stone-name';
    name.textContent = d.kind.rare ? `★ ${d.name}` : d.name;
    if (d.kind.rare) card.classList.add('rare');
    const meta = document.createElement('div');
    meta.className = 'stone-meta';
    const day = new Date(s.date);
    meta.textContent = `${day.getMonth() + 1}/${day.getDate()}・${s.kicks}回・${s.distance}m`;
    card.append(img, name, meta);
    grid.appendChild(card);
  });
  panel.classList.add('on');
}

