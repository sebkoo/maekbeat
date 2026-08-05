import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vitalsFrameSchema } from "@maekbeat/protocol";
import {
  ANOMALY_DEFAULTS,
  ANOMALY_PARAMS,
  GENERATOR_VERSION,
  SIM_DEFAULTS,
  takeFrames,
  type AnomalyOptions,
  type ScenarioName,
} from "./index";

// Golden fixtures pin the generator's exact bytes: one NDJSON file per scenario in
// golden/, a header line {seed, config, generatorVersion} followed by one frame per
// line. Regenerate with `pnpm -F @maekbeat/vitals-sim golden:update`. A golden diff IS
// a generator-contract change — intentional and explained in the commit body, never a
// way to silence a failing test (docs/ai/AI_USAGE.md loop contract).
//
// Statistical shape gates (autocorrelation, onset/recovery asymmetry) live in
// generator.test.ts: goldens pin bytes, stats pin shape.

interface GoldenSpec {
  scenario: ScenarioName;
  seed: number;
  count: number;
  anomaly?: Partial<AnomalyOptions>;
}

// Seeds are chosen for path coverage, asserted below: the rest fixture fires the
// fidget branch, the motion fixture contains a full burst, and the anomaly spec is
// sized so 120 ticks cross every boundary — event start (tick 30), first desat tick
// (40 = startTick + spo2LagTicks), desat window end (78 = 40 + 30 + 8 recovery-lag
// ticks), and a visible recovery tail (78..119).
const GOLDEN_SPECS: GoldenSpec[] = [
  { scenario: "rest", seed: 1, count: 120 },
  { scenario: "motion", seed: 5, count: 120 },
  {
    scenario: "anomaly",
    seed: 7,
    count: 120,
    anomaly: { startTick: 30, durationTicks: 30, spo2LagTicks: 10 },
  },
];

function goldenPath(scenario: ScenarioName): URL {
  return new URL(`../golden/${scenario}.ndjson`, import.meta.url);
}

// Serialization is JSON.stringify only, with key order fixed at construction (headers
// here, frames in generator.ts). ECMAScript specifies number-to-string exactly, so
// equal values produce equal bytes on every engine.
function buildGolden(spec: GoldenSpec): string {
  const config = {
    scenario: spec.scenario,
    deviceId: SIM_DEFAULTS.deviceId,
    startAtMs: SIM_DEFAULTS.startAtMs,
    tickMs: SIM_DEFAULTS.tickMs,
    count: spec.count,
    ...(spec.scenario === "anomaly" ? { anomaly: { ...ANOMALY_DEFAULTS, ...spec.anomaly } } : {}),
  };
  const header = { seed: spec.seed, config, generatorVersion: GENERATOR_VERSION };
  const frames = takeFrames(
    { scenario: spec.scenario, seed: spec.seed, anomaly: spec.anomaly },
    spec.count,
  );
  return [header, ...frames].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

if (process.env.UPDATE_GOLDENS === "1") {
  for (const spec of GOLDEN_SPECS) {
    writeFileSync(goldenPath(spec.scenario), buildGolden(spec));
  }
}

describe.each(GOLDEN_SPECS)("golden fixture: $scenario", (spec) => {
  const text = readFileSync(goldenPath(spec.scenario), "utf8");
  const lines = text.split("\n");
  const header = JSON.parse(lines[0] as string);
  const frames = lines.slice(1, -1).map((line) => JSON.parse(line) as unknown);

  it("matches a fresh generation byte for byte", () => {
    expect(text).toBe(buildGolden(spec));
  });

  it("ends with a newline and holds exactly `count` frames", () => {
    expect(lines.at(-1)).toBe("");
    expect(frames).toHaveLength(spec.count);
  });

  it("is regenerable from its own header alone", () => {
    expect(header.generatorVersion).toBe(GENERATOR_VERSION);
    const { scenario, deviceId, startAtMs, tickMs, count, anomaly } = header.config;
    const regenerated = takeFrames(
      { scenario, seed: header.seed, deviceId, startAtMs, tickMs, anomaly },
      count,
    );
    expect(regenerated).toEqual(frames);
  });

  it("passes vitalsFrameSchema for every fixture frame", () => {
    for (const frame of frames) {
      expect(vitalsFrameSchema.parse(frame)).toEqual(frame);
    }
  });
});

describe("fixture path coverage", () => {
  function fixtureMotion(scenario: ScenarioName): number[] {
    return readFileSync(goldenPath(scenario), "utf8")
      .split("\n")
      .slice(1, -1)
      .map((line) => (JSON.parse(line) as { motion: number }).motion);
  }

  it("rest fixture pins the fidget branch, not just the idle path", () => {
    const motion = fixtureMotion("rest");
    expect(Math.max(...motion)).toBeGreaterThan(0.02);
    expect(motion.reduce((a, b) => a + b, 0) / motion.length).toBeLessThan(0.05);
  });

  it("motion fixture contains a full activity burst", () => {
    expect(Math.max(...fixtureMotion("motion"))).toBeGreaterThan(0.3);
  });
});

describe("anomaly fixture boundary coverage", () => {
  const spec = GOLDEN_SPECS.find((s) => s.scenario === "anomaly") as GoldenSpec;
  const a: AnomalyOptions = { ...ANOMALY_DEFAULTS, ...spec.anomaly };
  const desatStartTick = a.startTick + a.spo2LagTicks;
  const desatEndTick = desatStartTick + a.durationTicks + ANOMALY_PARAMS.spo2RecoveryLagTicks;

  it("crosses event start, first desat tick, desat end, and a recovery tail", () => {
    expect(a.startTick).toBeGreaterThan(0);
    expect(desatEndTick).toBeLessThan(spec.count);

    const text = readFileSync(goldenPath("anomaly"), "utf8");
    const spo2 = text
      .split("\n")
      .slice(1, -1)
      .map((line) => (JSON.parse(line) as { spo2Pct: number }).spo2Pct);
    // Baseline SpO2 holds through the lag, a real trough follows, and by the last
    // fixture tick recovery is visibly under way.
    for (const value of spo2.slice(0, desatStartTick)) {
      expect(value).toBeGreaterThanOrEqual(95);
    }
    const trough = Math.min(...spo2);
    expect(trough).toBeLessThan(93);
    expect(spo2[spec.count - 1]).toBeGreaterThan(trough + 1);
  });
});
