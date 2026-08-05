// Cross-platform determinism contract for this file: only operations whose results are
// bit-exact under IEEE 754 on every JS engine — 32-bit integer ops, +, -, *, / — so the
// same seed yields the same byte sequence everywhere (the C3 golden-file precondition).
// Math.sin/exp/log/cos are banned here: engines may round them differently.

/** mulberry32 — pure 32-bit PRNG. Returns a function yielding uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Approximate standard normal: rescaled sum of three uniforms (Irwin–Hall), mean 0,
 * variance ~1, hard-bounded to ±3. Chosen over Box–Muller to avoid Math.log/Math.cos.
 */
export function gaussian(rng: () => number): number {
  return (rng() + rng() + rng() - 1.5) * 2;
}
