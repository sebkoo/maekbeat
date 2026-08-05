import type { AlertEvent } from "@maekbeat/protocol";
import { mulberry32 } from "@maekbeat/vitals-sim";
import { describe, expect, it } from "vitest";

import { AlertEngine, type AlertRuleConfig } from "./alerts";
import type { StoredVitalsFrame } from "./store";

// Promoted from the C7 review's ad-hoc clock-regression fuzz into permanent
// regression armor. Fixed seeds + fixed iteration counts keep CI
// deterministic. Budget: 10 seeds x 400 frames, each run evaluated twice
// (raw clock + monotonicized clock) = 8,000 engine evaluations.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const FRAMES_PER_RUN = 400;
const BASE_MS = 10_000_000;

/** Tight rule so the fuzz crosses states often: enter <90 x3, exit >=93 x3. */
const FUZZ_RULE: AlertRuleConfig = {
  id: "spo2-low",
  metric: "spo2Pct",
  direction: "low",
  enterThreshold: 90,
  exitThreshold: 93,
  enterCount: 3,
  exitCount: 3,
  windowMs: 5_000,
  cooldownMs: 10_000,
};

/**
 * SpO2 random-walks across both thresholds while receivedAtMs advances
 * normally ~70% of the time, steps BACK up to 20 s ~15% (server clock
 * regression), and leaps forward up to 20 s otherwise.
 */
function fuzzFrames(seed: number): StoredVitalsFrame[] {
  const rng = mulberry32(seed);
  let spo2 = 96;
  let clock = BASE_MS;
  const frames: StoredVitalsFrame[] = [];
  for (let seq = 0; seq < FRAMES_PER_RUN; seq++) {
    spo2 = Math.min(100, Math.max(80, spo2 + (rng() - 0.5) * 6));
    const r = rng();
    if (r < 0.7) clock += 500 + Math.floor(rng() * 1_000);
    else if (r < 0.85) clock -= Math.floor(rng() * 20_000);
    else clock += Math.floor(rng() * 20_000);
    frames.push({
      v: 1,
      deviceId: "fuzz-dev",
      seq,
      capturedAtMs: BASE_MS + seq * 1_000,
      heartRateBpm: 70,
      spo2Pct: Math.round(spo2 * 10) / 10,
      respirationRpm: 14,
      motion: 0,
      receivedAtMs: clock,
      sessionEpoch: 1,
    });
  }
  return frames;
}

function transitionTimeMs(t: AlertEvent): number {
  return t.state === "resolved" ? (t.resolvedAtMs ?? Number.NaN) : t.raisedAtMs;
}

describe("AlertEngine under seeded clock-regression fuzz", () => {
  it("holds lifecycle invariants for every seed, whatever the clock does", () => {
    let totalTransitions = 0;
    for (const seed of SEEDS) {
      const frames = fuzzFrames(seed);
      const engine = new AlertEngine([FUZZ_RULE]);
      const transitions = frames.flatMap((f) => engine.process(f));
      totalTransitions += transitions.length;

      // Strict alternation: raised, resolved, raised, ... — never two raises
      // without a resolve between, never a resolve without an open alert.
      transitions.forEach((t, i) => {
        expect(t.state).toBe(i % 2 === 0 ? "raised" : "resolved");
      });

      // Each resolve closes the raise before it, dated no earlier.
      for (let i = 0; i + 1 < transitions.length; i += 2) {
        const raise = transitions[i] as AlertEvent;
        const resolve = transitions[i + 1] as AlertEvent;
        expect(resolve.alertId).toBe(raise.alertId);
        expect(resolve.resolvedAtMs ?? -1).toBeGreaterThanOrEqual(raise.raisedAtMs);
      }

      // Transition times never run backwards, even when input stamps do.
      for (let i = 1; i < transitions.length; i++) {
        expect(transitionTimeMs(transitions[i] as AlertEvent)).toBeGreaterThanOrEqual(
          transitionTimeMs(transitions[i - 1] as AlertEvent),
        );
      }

      // Ids unique; counters consistent; caps respected.
      const raiseIds = transitions.filter((t) => t.state === "raised").map((t) => t.alertId);
      expect(new Set(raiseIds).size).toBe(raiseIds.length);
      const counters = engine.countersFor("fuzz-dev");
      expect(counters.raised - counters.resolved).toBeGreaterThanOrEqual(0);
      expect(counters.raised - counters.resolved).toBeLessThanOrEqual(1);
      expect(engine.listAlerts("fuzz-dev").length).toBeLessThanOrEqual(100);
      for (const t of transitions) {
        // MAX_WINDOW_SAMPLES in src/alerts.ts — the forward-leap freeze bound.
        expect(t.windowStats.sampleCount).toBeLessThanOrEqual(512);
      }

      // The design claim itself: the engine behaves as if it saw the
      // monotonicized clock. Regressions must change NOTHING.
      const monoEngine = new AlertEngine([FUZZ_RULE]);
      let monoClock = -Infinity;
      const monoTransitions = frames.flatMap((f) => {
        monoClock = Math.max(monoClock, f.receivedAtMs);
        return monoEngine.process({ ...f, receivedAtMs: monoClock });
      });
      expect(monoTransitions).toEqual(transitions);
    }
    // Guard against a vacuous sweep: measured 45 transitions across these 10
    // seeds at these iteration counts; a generator change that quiets the
    // fuzz below half that should fail loudly, not pass silently.
    expect(totalTransitions).toBeGreaterThanOrEqual(22);
  });

  it("survives a frozen clock: raises and resolves on counts, then latches", () => {
    const engine = new AlertEngine([FUZZ_RULE]);
    const at = (seq: number, spo2Pct: number): StoredVitalsFrame => ({
      v: 1,
      deviceId: "frozen-dev",
      seq,
      capturedAtMs: BASE_MS + seq * 1_000,
      heartRateBpm: 70,
      spo2Pct,
      respirationRpm: 14,
      motion: 0,
      // Every frame carries the SAME receive stamp: windows never expire by
      // time and the cooldown never elapses.
      receivedAtMs: BASE_MS,
      sessionEpoch: 1,
    });

    const transitions: AlertEvent[] = [];
    let seq = 0;
    for (let episode = 0; episode < 4; episode++) {
      for (const spo2 of [88, 88, 88, 95, 95, 95]) {
        transitions.push(...engine.process(at(seq, spo2)));
        seq += 1;
      }
    }

    // One pair, dated at the frozen instant; later episodes sit inside the
    // never-elapsing cooldown and are suppressed — counted, not raised.
    expect(transitions.map((t) => t.state)).toEqual(["raised", "resolved"]);
    expect(transitions[1]?.resolvedAtMs).toBe(transitions[0]?.raisedAtMs);
    expect(engine.countersFor("frozen-dev")).toEqual({ raised: 1, resolved: 1, suppressed: 3 });
  });
});
