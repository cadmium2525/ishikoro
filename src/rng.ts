/** シード付き乱数（mulberry32）。同じシードなら同じ通学路・石になる。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平均0・標準偏差1の正規乱数 */
export function gaussian(rand: () => number = Math.random): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** フレームレート非依存の指数減衰補間係数 */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
