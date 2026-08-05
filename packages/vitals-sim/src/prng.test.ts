import { describe, expect, it } from "vitest";
import { gaussian, mulberry32 } from "./index";

describe("mulberry32", () => {
  it("yields the identical sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it("yields different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const drawsA = Array.from({ length: 10 }, () => a());
    const drawsB = Array.from({ length: 10 }, () => b());
    expect(drawsA).not.toEqual(drawsB);
  });

  it("stays in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("gaussian", () => {
  it("is hard-bounded to ±3 and centered near 0", () => {
    const rng = mulberry32(11);
    let sum = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const z = gaussian(rng);
      expect(Math.abs(z)).toBeLessThanOrEqual(3);
      sum += z;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
  });
});
