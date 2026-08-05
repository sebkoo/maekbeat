import { describe, expect, it } from "vitest";
import { vitalsFrameSchema } from "@maekbeat/protocol";
import {
  ANOMALY_DEFAULTS,
  REST_PARAMS,
  SIM_DEFAULTS,
  generateVitals,
  takeFrames,
  type SimOptions,
} from "./index";

const SCENARIOS: SimOptions["scenario"][] = ["rest", "motion", "anomaly"];

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function lag1Autocorrelation(xs: number[]): number {
  const m = mean(xs);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i++) {
    denominator += ((xs[i] as number) - m) ** 2;
    if (i > 0) numerator += ((xs[i] as number) - m) * ((xs[i - 1] as number) - m);
  }
  return numerator / denominator;
}

describe("seeded determinism", () => {
  it.each(SCENARIOS)(
    "%s: same seed twice yields a deep-equal, byte-identical sequence",
    (scenario) => {
      const a = takeFrames({ scenario, seed: 1234 }, 300);
      const b = takeFrames({ scenario, seed: 1234 }, 300);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    },
  );

  it("different seeds yield different sequences", () => {
    const a = takeFrames({ scenario: "rest", seed: 1 }, 50);
    const b = takeFrames({ scenario: "rest", seed: 2 }, 50);
    expect(a).not.toEqual(b);
  });
});

describe("protocol contract", () => {
  it.each(SCENARIOS)("%s: every emitted frame passes vitalsFrameSchema unchanged", (scenario) => {
    for (const frame of takeFrames({ scenario, seed: 99 }, 300)) {
      expect(vitalsFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it("seq is strictly monotonic from 0 and capturedAtMs advances by tickMs", () => {
    const frames = takeFrames({ scenario: "rest", seed: 5, tickMs: 250 }, 100);
    frames.forEach((frame, i) => {
      expect(frame.seq).toBe(i);
      expect(frame.capturedAtMs).toBe(SIM_DEFAULTS.startAtMs + i * 250);
    });
  });
});

describe("rest scenario shape", () => {
  const frames = takeFrames({ scenario: "rest", seed: 42 }, 300);
  const hr = frames.map((f) => f.heartRateBpm);

  it("keeps SpO2 in 96-99 and respiration in 12-16", () => {
    for (const f of frames) {
      expect(f.spo2Pct).toBeGreaterThanOrEqual(96);
      expect(f.spo2Pct).toBeLessThanOrEqual(99);
      expect(f.respirationRpm).toBeGreaterThanOrEqual(12);
      expect(f.respirationRpm).toBeLessThanOrEqual(16);
    }
  });

  it("wanders HR smoothly around baseline — variable but not white noise", () => {
    for (const bpm of hr) {
      expect(bpm).toBeGreaterThanOrEqual(50);
      expect(bpm).toBeLessThanOrEqual(75);
    }
    // Variability exists...
    expect(new Set(hr).size).toBeGreaterThan(3);
    // ...but consecutive beats stay close: smooth wander + small jitter, not independent draws.
    const meanStep = mean(hr.slice(1).map((bpm, i) => Math.abs(bpm - (hr[i] as number))));
    expect(meanStep).toBeLessThan(3);
    // The decisive gate against white noise: i.i.d. draws have lag-1 autocorrelation near 0,
    // the AR(1) wander pushes this trace to ~0.75.
    expect(lag1Autocorrelation(hr)).toBeGreaterThan(0.5);
  });

  it("keeps motion near zero", () => {
    expect(mean(frames.map((f) => f.motion))).toBeLessThan(0.05);
  });
});

describe("motion scenario shape", () => {
  const frames = takeFrames({ scenario: "motion", seed: 42 }, 300);

  it("activates the motion channel with real bursts", () => {
    expect(Math.max(...frames.map((f) => f.motion))).toBeGreaterThan(0.3);
  });

  it("elevates HR on high-motion ticks over low-motion ticks", () => {
    const high = frames.filter((f) => f.motion > 0.3).map((f) => f.heartRateBpm);
    const low = frames.filter((f) => f.motion < 0.1).map((f) => f.heartRateBpm);
    expect(high.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);
    expect(mean(high)).toBeGreaterThan(mean(low) + 10);
  });

  it("raises HR faster at burst onset than it recovers after the burst ends", () => {
    // Seed 5 produces one isolated burst (ticks ~40-79) followed by a quiet stretch,
    // so onset and recovery can be measured without a second burst interfering.
    const trace = takeFrames({ scenario: "motion", seed: 5 }, 400);
    const baseline = REST_PARAMS.hrBaselineBpm;
    const rise = trace.findIndex((f) => f.motion > 0.5);
    expect(rise).toBeGreaterThan(0);
    const fall = trace.findIndex((f, i) => i > rise && f.motion < 0.15);
    expect(fall).toBeGreaterThan(rise);
    expect(trace.slice(fall, fall + 35).every((f) => f.motion < 0.2)).toBe(true);

    const hr = trace.map((f) => f.heartRateBpm);
    const riseTicks = hr.slice(rise).findIndex((bpm) => bpm >= baseline + 25);
    const decayTicks = hr.slice(fall).findIndex((bpm) => bpm <= baseline + 10);
    expect(riseTicks).toBeGreaterThanOrEqual(0);
    expect(decayTicks).toBeGreaterThanOrEqual(0);
    // Onset gain 0.25 vs recovery gain 0.05: climbing +25 bpm takes a handful of ticks,
    // settling back takes several times longer.
    expect(decayTicks).toBeGreaterThan(riseTicks * 2);
    // Elevation outlasts the movement: motion is already low, HR is still up.
    expect(hr[fall + 2]).toBeGreaterThan(baseline + 15);
  });
});

describe("anomaly scenario shape", () => {
  const { startTick, durationTicks, spo2LagTicks } = ANOMALY_DEFAULTS;
  const frames = takeFrames({ scenario: "anomaly", seed: 42 }, 200);

  it("holds a rest-like baseline before the event", () => {
    const before = frames.slice(0, startTick);
    expect(mean(before.map((f) => f.heartRateBpm))).toBeGreaterThan(55);
    expect(mean(before.map((f) => f.heartRateBpm))).toBeLessThan(70);
  });

  it("spikes HR inside the event window", () => {
    const during = frames.slice(startTick, startTick + durationTicks);
    expect(Math.max(...during.map((f) => f.heartRateBpm))).toBeGreaterThan(90);
  });

  it("supports HR suppression as the parameterized alternative", () => {
    const suppressed = takeFrames(
      { scenario: "anomaly", seed: 42, anomaly: { hrExcursion: "suppression" } },
      200,
    );
    const during = suppressed.slice(startTick, startTick + durationTicks);
    expect(Math.min(...during.map((f) => f.heartRateBpm))).toBeLessThan(48);
  });

  it("delays SpO2 desaturation past the event start — never a same-tick drop", () => {
    // Through the whole lag window (event already running), SpO2 still reads as baseline.
    const beforeLagEnds = frames.slice(0, startTick + spo2LagTicks);
    for (const f of beforeLagEnds) {
      expect(f.spo2Pct).toBeGreaterThanOrEqual(95);
    }
    const spo2 = frames.map((f) => f.spo2Pct);
    const minSpo2 = Math.min(...spo2);
    expect(minSpo2).toBeLessThan(92);
    expect(spo2.indexOf(minSpo2)).toBeGreaterThanOrEqual(startTick + spo2LagTicks);
  });

  it("makes respiration irregular during the event", () => {
    const before = frames.slice(0, startTick).map((f) => f.respirationRpm);
    const during = frames.slice(startTick, startTick + durationTicks).map((f) => f.respirationRpm);
    expect(std(during)).toBeGreaterThan(std(before) * 2);
  });

  it("rejects a zero SpO2 lag — desaturation must not share the event's first tick", () => {
    expect(() =>
      takeFrames({ scenario: "anomaly", seed: 1, anomaly: { spo2LagTicks: 0 } }, 1),
    ).toThrow(RangeError);
  });

  it("still desaturates when the lag exceeds the event duration", () => {
    // The desat window mirrors the event length shifted by the lag, so a short event
    // with a long lag cannot produce an accidentally empty window.
    const shifted = { startTick: 10, durationTicks: 5, spo2LagTicks: 20 };
    const trace = takeFrames({ scenario: "anomaly", seed: 7, anomaly: shifted }, 200);
    const spo2 = trace.map((f) => f.spo2Pct);
    for (const value of spo2.slice(0, shifted.startTick + shifted.spo2LagTicks)) {
      expect(value).toBeGreaterThanOrEqual(95);
    }
    expect(Math.min(...spo2)).toBeLessThan(93);
  });

  it("rejects an unknown hrExcursion value from plain-JS callers", () => {
    const bad = { hrExcursion: "flatline" as "spike" };
    expect(() => takeFrames({ scenario: "anomaly", seed: 1, anomaly: bad }, 1)).toThrow(RangeError);
  });
});

describe("option validation", () => {
  it("rejects a non-integer seed", () => {
    expect(() => takeFrames({ scenario: "rest", seed: 1.5 }, 1)).toThrow(RangeError);
  });

  it("rejects an out-of-contract deviceId", () => {
    expect(() => takeFrames({ scenario: "rest", seed: 1, deviceId: "" }, 1)).toThrow(RangeError);
    expect(() => takeFrames({ scenario: "rest", seed: 1, deviceId: "d".repeat(65) }, 1)).toThrow(
      RangeError,
    );
  });

  it("rejects an unknown scenario from plain-JS callers", () => {
    expect(() => takeFrames({ scenario: "sprint" as "rest", seed: 1 }, 1)).toThrow(RangeError);
  });

  it("refuses to emit a frame whose capturedAtMs would lose integer precision", () => {
    // Seq 0 is exactly representable, seq 1 would pass 2^53 — the generator throws
    // instead of emitting a timestamp the protocol's z.int() would reject.
    const options = { scenario: "rest", seed: 1, tickMs: Number.MAX_SAFE_INTEGER } as const;
    expect(takeFrames(options, 1)).toHaveLength(1);
    expect(() => takeFrames(options, 2)).toThrow(RangeError);
    expect(() =>
      takeFrames({ scenario: "rest", seed: 1, startAtMs: Number.MAX_SAFE_INTEGER + 1 }, 1),
    ).toThrow(RangeError);
  });

  it("rejects non-positive tickMs and startAtMs", () => {
    expect(() => takeFrames({ scenario: "rest", seed: 1, tickMs: 0 }, 1)).toThrow(RangeError);
    expect(() => takeFrames({ scenario: "rest", seed: 1, startAtMs: 0 }, 1)).toThrow(RangeError);
  });

  it("streams indefinitely via the generator form", () => {
    const generator = generateVitals({ scenario: "rest", seed: 3 });
    const first = generator.next().value;
    const second = generator.next().value;
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
  });
});
