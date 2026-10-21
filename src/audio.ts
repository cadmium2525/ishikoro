/**
 * 合成音による効果音と環境音。音源ファイルは使わず、すべてその場で作る。
 * 最初のユーザー操作で AudioContext を起こす（ブラウザの自動再生制限のため）。
 */

export type Ambience = 'noon' | 'evening' | 'cloudy';

const MUTE_KEY = 'ishikoro.mute';

export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  /** すべての音はここを通る（消音用） */
  private master: GainNode | null = null;
  /** 環境音だけの音量（失敗したときに静かにする） */
  private ambBus: GainNode | null = null;
  private trafficGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private ambience: Ambience = 'noon';
  /** 次の鳥・蝉・カラスまでの時間 */
  private nextBird = 2;
  private nextInsect = 1;
  private nextCrow = 6;
  private stepT = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* 保存できない環境では毎回鳴らす */
    }
  }

  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const len = Math.floor(ctx.sampleRate * 0.3);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(ctx.destination);
      this.ambBus = ctx.createGain();
      this.ambBus.connect(this.master);
      this.startLoops();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* 保存できなくても今回は効く */
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  /** その日の空模様に合わせた環境音 */
  setAmbience(a: Ambience) {
    this.ambience = a;
    this.nextInsect = 0.5;
    if (this.ctx && this.windGain) this.windGain.gain.setTargetAtTime(a === 'cloudy' ? 0.16 : 0.07, this.ctx.currentTime, 1);
  }

  /** 環境音の大きさ（1：ふだん、小さくすると静けさ） */
  setAmbienceLevel(v: number) {
    if (this.ctx && this.ambBus) this.ambBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  /** 毎フレーム：鳥・蝉・カラスをときどき鳴かせる */
  tick(dt: number) {
    if (!this.ctx) return;
    this.nextBird -= dt;
    this.nextInsect -= dt;
    this.nextCrow -= dt;
    if (this.nextBird <= 0) {
      if (this.ambience !== 'evening') this.bird();
      this.nextBird = 3 + Math.random() * 7;
    }
    if (this.nextInsect <= 0) {
      if (this.ambience === 'noon') this.cicada();
      else if (this.ambience === 'evening') this.higurashi();
      this.nextInsect = this.ambience === 'noon' ? 5 + Math.random() * 4 : 7 + Math.random() * 6;
    }
    if (this.nextCrow <= 0) {
      if (this.ambience === 'evening' || this.ambience === 'cloudy') this.crow();
      this.nextCrow = 12 + Math.random() * 14;
    }
  }

  /** 車の走行音。近い車ほど大きく（level 0..1） */
  setTraffic(level: number) {
    if (!this.ctx || !this.trafficGain) return;
    this.trafficGain.gain.setTargetAtTime(level * level * 0.5, this.ctx.currentTime, 0.15);
  }

  /** 主人公の足音（速さ [m/s] に合わせて） */
  footsteps(speed: number, dt: number) {
    if (!this.ctx || speed < 0.4) return;
    this.stepT -= dt;
    if (this.stepT <= 0) {
      this.click(500 + Math.random() * 200, 0.05 + speed * 0.015, 0.05);
      this.stepT = 1.1 / (1.2 + speed);
    }
  }

  /** 側溝・集水ます・田んぼ・マンホールに落ちた音 */
  plop() {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime + 0.12;
    osc.frequency.setValueAtTime(700, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.15);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g).connect(this.out);
    osc.start(ctx.currentTime);
    osc.stop(t + 0.25);
  }

  /** 夕方5時のチャイム（キン・コン・カン・コン） */
  chime() {
    this.melody([659.3, 523.3, 587.3, 392.0], 0.5, 0.25, 1.2);
  }

  /** 家に着いた：やわらかい上がる音 */
  home() {
    this.melody([523.3, 659.3, 784.0], 0.22, 0.16, 1.4);
  }

  /** その日がおしまい：静かに下がる音 */
  sad() {
    this.melody([392.0, 349.2, 293.7], 0.35, 0.12, 1.2);
  }

  /** 自転車のベル（チリンチリン） */
  bell() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let k = 0; k < 2; k++) {
      for (const f of [2350, 3150]) {
        const t = ctx.currentTime + k * 0.22;
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
        osc.connect(g).connect(this.out);
        osc.start(t);
        osc.stop(t + 0.55);
      }
    }
  }

  /** ねこ（ニャッ） */
  meow() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(650, t);
    osc.frequency.linearRampToValueAtTime(1050, t + 0.12);
    osc.frequency.linearRampToValueAtTime(620, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  /** 怒った声の代わり（ムッとした低い2音） */
  scold() {
    const ctx = this.ctx;
    if (!ctx) return;
    [0, 0.18].forEach((d, i) => {
      const t = ctx.currentTime + 0.15 + d;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(i ? 210 : 260, t);
      osc.frequency.linearRampToValueAtTime(i ? 170 : 230, t + 0.14);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900;
      f.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(f).connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  }

  /** ねこが怒る（シャーッ） */
  hiss() {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2800;
    const g = ctx.createGain();
    const t = ctx.currentTime + 0.1;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(f).connect(g).connect(this.out);
    src.start(ctx.currentTime);
    src.stop(t + 0.85);
  }

  /** 犬（ワンワン） */
  bark() {
    for (let k = 0; k < 2; k++) setTimeout(() => this.click(520, 0.6, 0.12), k * 220);
  }

  /** 車にはじかれた鈍い音 */
  thud() {
    this.click(260, 0.9, 0.12);
    this.click(1500, 0.5, 0.06);
  }

  /** 靴が石に当たる乾いた音 */
  kick(power: number) {
    this.click(900 + power * 500, 0.35 + power * 0.4, 0.07);
  }

  /** 石が塀や地面に当たる音 */
  impact(strength: number) {
    if (strength < 0.05) return;
    this.click(1800 + Math.random() * 600, 0.15 + strength * 0.5, 0.05);
  }

  // ---------- 内部 ----------

  private get out(): AudioNode {
    return this.master!;
  }

  /** ずっと鳴っている音：車の走行音・風 */
  private startLoops() {
    const ctx = this.ctx!;
    // ブラウンノイズ（低い音が多いざわめき）をループで使い回す
    const len = ctx.sampleRate * 2;
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const loop = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    };
    // 車
    const tf = ctx.createBiquadFilter();
    tf.type = 'lowpass';
    tf.frequency.value = 420;
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    loop(brown).connect(tf).connect(this.trafficGain).connect(this.out);
    // 風：ゆっくり強弱をつける
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 380;
    wf.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = this.ambience === 'cloudy' ? 0.16 : 0.07;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(this.windGain.gain);
    lfo.start();
    loop(brown).connect(wf).connect(this.windGain).connect(this.ambBus!);
  }

  private melody(freqs: number[], step: number, vol: number, decay: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + decay + 0.1);
    });
  }

  /** 小鳥のさえずり（短く上がる音を数回） */
  private bird() {
    const ctx = this.ctx!;
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 2600 + Math.random() * 1200;
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.12 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.4, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.025, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
      osc.connect(g).connect(this.ambBus!);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  /** 昼の蝉（ミーンミンミン）：高い音を細かく震わせる */
  private cicada() {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 3800;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 4200;
    bp.Q.value = 3;
    const am = ctx.createOscillator();
    am.frequency.value = 7;
    const amGain = ctx.createGain();
    amGain.gain.value = 0.012;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.014, t0 + 0.4);
    g.gain.setValueAtTime(0.014, t0 + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.4);
    am.connect(amGain).connect(g.gain);
    osc.connect(bp).connect(g).connect(this.ambBus!);
    osc.start(t0);
    am.start(t0);
    osc.stop(t0 + 3.5);
    am.stop(t0 + 3.5);
  }

  /** 夕方のひぐらし（カナカナカナ…）：下がっていく震える音 */
  private higurashi() {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(4600, t0);
    osc.frequency.exponentialRampToValueAtTime(3600, t0 + 2.8);
    const am = ctx.createOscillator();
    am.frequency.value = 16;
    const amGain = ctx.createGain();
    amGain.gain.value = 0.02;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.022, t0 + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.0);
    am.connect(amGain).connect(g.gain);
    osc.connect(g).connect(this.ambBus!);
    osc.start(t0);
    am.start(t0);
    osc.stop(t0 + 3.1);
    am.stop(t0 + 3.1);
  }

  /** 遠くのカラス（カー、カー） */
  private crow() {
    const ctx = this.ctx!;
    for (let k = 0; k < 2; k++) {
      const t = ctx.currentTime + k * 0.55;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(620, t);
      osc.frequency.linearRampToValueAtTime(520, t + 0.35);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1100;
      f.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.03, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.38);
      osc.connect(f).connect(g).connect(this.ambBus!);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  }

  private click(freq: number, gain: number, dur: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 4;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.2, dur);
  }
}
