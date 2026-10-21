/** 合成音による最小限の効果音。最初のユーザー操作で AudioContext を起こす。 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private trafficGain: GainNode | null = null;

  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const len = Math.floor(this.ctx.sampleRate * 0.3);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.trafficGain) this.startTraffic();
  }

  /** 車の走行音。近い車ほど大きく（level 0..1） */
  setTraffic(level: number) {
    if (!this.ctx || !this.trafficGain) return;
    this.trafficGain.gain.setTargetAtTime(level * level * 0.5, this.ctx.currentTime, 0.15);
  }

  /** 側溝に落ちた音 */
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
    osc.connect(g).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(t + 0.25);
  }

  /** 夕方5時のチャイム（キン・コン・カン・コン） */
  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    [659.3, 523.3, 587.3, 392.0].forEach((f, i) => {
      const t = ctx.currentTime + i * 0.5;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1.3);
    });
  }

  /** 車にはじかれた鈍い音 */
  thud() {
    this.click(260, 0.9, 0.12);
    this.click(1500, 0.5, 0.06);
  }

  private startTraffic() {
    const ctx = this.ctx!;
    // ブラウンノイズをループさせ、低域だけ通してエンジン・タイヤ音の代わりにする
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    src.connect(filter).connect(this.trafficGain).connect(ctx.destination);
    src.start();
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
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(t, Math.random() * 0.2, dur);
  }
}
