import { clamp } from './rng';

/** 方向ガイドの振れ幅（片側） */
export const AIM_RANGE = Math.PI / 3;
/** 方向ガイドの往復速度 [rad/s]（sin の位相速度）の初期値。難しさで変わる */
const SWEEP_RATE = 2.1;
/** 0 から 1 までチャージする時間 [s] */
const CHARGE_TIME = 1.3;
/** 1 を超えて溜められる上限（蹴りすぎ）。超えると 0 に戻る */
export const OVERCHARGE_MAX = 1.18;
/** 回転が最大になる横ドラッグ量 [CSS px] */
const SPIN_DRAG_PX = 70;

export interface KickInput {
  /** 中心方向からのずれ（ラジアン） */
  aimOffset: number;
  power: number;
  spin: number;
}

type Phase = 'disabled' | 'aim' | 'charge';

/**
 * ワンジェスチャーのキック操作。
 * 方向ガイドが往復 → タップで方向決定 → 押し続けて強さ → 左右にずらして回転 → 離してキック
 */
export class KickInputController {
  phase: Phase = 'disabled';
  /** 往復している方向ガイドの現在値 */
  sweep = 0;
  /** タップで確定した方向 */
  lockedAim = 0;
  power = 0;
  spin = 0;
  /** 方向ガイドの往復の速さ（難しいほど速い） */
  sweepRate = SWEEP_RATE;

  onKick?: (input: KickInput) => void;

  private sweepPhase = 0;
  private pointerId: number | null = null;
  private startX = 0;

  constructor(private readonly target: HTMLElement) {
    target.addEventListener('pointerdown', this.handleDown);
    target.addEventListener('pointermove', this.handleMove);
    target.addEventListener('pointerup', this.handleUp);
    target.addEventListener('pointercancel', this.handleCancel);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  enable() {
    this.phase = 'aim';
    this.power = 0;
    this.spin = 0;
    // 毎回同じ位置から振り始めると覚えゲーになるので位相をずらす
    this.sweepPhase = Math.random() * Math.PI * 2;
  }

  disable() {
    this.phase = 'disabled';
    this.pointerId = null;
  }

  update(dt: number) {
    if (this.phase === 'aim') {
      this.sweepPhase += this.sweepRate * dt;
      this.sweep = Math.sin(this.sweepPhase) * AIM_RANGE;
    } else if (this.phase === 'charge') {
      // 上限まで溜まったら 0 に戻ってまた溜まる
      this.power += dt / CHARGE_TIME;
      if (this.power > OVERCHARGE_MAX) this.power -= OVERCHARGE_MAX;
    }
  }

  private handleDown = (e: PointerEvent) => {
    if (this.phase !== 'aim' || this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.target.setPointerCapture(e.pointerId);
    this.lockedAim = this.sweep;
    this.startX = e.clientX;
    this.power = 0;
    this.spin = 0;
    this.phase = 'charge';
  };

  private handleMove = (e: PointerEvent) => {
    if (this.phase !== 'charge' || e.pointerId !== this.pointerId) return;
    this.spin = clamp((e.clientX - this.startX) / SPIN_DRAG_PX, -1, 1);
  };

  private handleUp = (e: PointerEvent) => {
    if (this.phase !== 'charge' || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.phase = 'disabled';
    this.onKick?.({ aimOffset: this.lockedAim, power: this.power, spin: this.spin });
  };

  private handleCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.phase === 'charge') this.phase = 'aim';
  };
}
