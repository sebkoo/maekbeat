import type { VitalsFrame } from "@maekbeat/protocol";
import { takeFrames, type SimOptions } from "@maekbeat/vitals-sim";
import { describe, expect, it } from "vitest";

import { AlertEngine, DEFAULT_ALERT_RULES, type AlertRuleConfig } from "./alerts";
import type { StoredVitalsFrame } from "./store";

const BASE_MS = 1_000_000;

/** Synthetic frame with injected receive time — the engine never sees a clock. */
function frameAt(tick: number, values: Partial<VitalsFrame> = {}): StoredVitalsFrame {
  return {
    v: 1,
    deviceId: "unit-dev",
    seq: tick,
    capturedAtMs: BASE_MS + tick * 1_000,
    heartRateBpm: 62,
    spo2Pct: 97.5,
    respirationRpm: 14,
    motion: 0,
    receivedAtMs: BASE_MS + tick * 1_000,
    sessionEpoch: 1,
    ...values,
  };
}

/** One tight test rule: SpO2 low, enter <90 x3, exit >=93 x3, 5 s window. */
const TEST_RULE: AlertRuleConfig = {
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

function tickOf(ms: number): number {
  return (ms - BASE_MS) / 1_000;
}

describe("AlertEngine lifecycle", () => {
  it("raises once after N in-window breaches, then marks the alert ongoing", () => {
    const engine = new AlertEngine([TEST_RULE]);
    const events = [
      ...engine.process(frameAt(0, { spo2Pct: 89 })),
      ...engine.process(frameAt(1, { spo2Pct: 88 })),
    ];
    expect(events).toHaveLength(0);

    const raised = engine.process(frameAt(2, { spo2Pct: 89 }));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ state: "raised", metric: "spo2Pct", direction: "low" });
    expect(raised[0]?.raisedAtMs).toBe(BASE_MS + 2_000);

    // Further breaches extend the same alert — no second raise.
    expect(engine.process(frameAt(3, { spo2Pct: 87 }))).toHaveLength(0);
    const listed = engine.listAlerts("unit-dev");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe("ongoing");
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 1, resolved: 0, suppressed: 0 });
  });

  it("resists flapping: values between exit and enter thresholds hold the alert open", () => {
    const engine = new AlertEngine([TEST_RULE]);
    for (const spo2 of [89, 88, 89]) {
      engine.process(frameAt(0 + [89, 88, 89].indexOf(spo2), { spo2Pct: spo2 }));
    }
    let tick = 3;
    // 91/89 flaps sit below the 93 exit threshold: never 3 recovered samples.
    for (const spo2 of [91, 89, 91, 89, 91, 89]) {
      const events = engine.process(frameAt(tick, { spo2Pct: spo2 }));
      expect(events).toHaveLength(0);
      tick += 1;
    }
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 1, resolved: 0, suppressed: 0 });

    // Sustained recovery resolves exactly once.
    let resolved: unknown[] = [];
    for (const spo2 of [94, 94, 95]) {
      resolved = [...resolved, ...engine.process(frameAt(tick, { spo2Pct: spo2 }))];
      tick += 1;
    }
    expect(resolved).toHaveLength(1);
    expect(engine.listAlerts("unit-dev")[0]?.state).toBe("resolved");
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
  });

  it("suppresses a re-fire inside the cooldown (counted once), raises after it expires", () => {
    const engine = new AlertEngine([TEST_RULE]);
    let tick = 0;
    for (const spo2 of [89, 89, 89, 94, 94, 94]) {
      engine.process(frameAt(tick, { spo2Pct: spo2 }));
      tick += 1;
    }
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
    const resolvedAtTick = 5;

    // Breach again immediately: inside the 10 s cooldown — suppressed, once.
    for (const spo2 of [88, 88, 88, 88, 88]) {
      expect(engine.process(frameAt(tick, { spo2Pct: spo2 }))).toHaveLength(0);
      tick += 1;
    }
    expect(engine.countersFor("unit-dev").suppressed).toBe(1);

    // The breach persists past cooldown expiry: it raises then — delayed,
    // never silenced forever.
    let secondRaise: ReturnType<AlertEngine["process"]> = [];
    while (secondRaise.length === 0 && tick < 40) {
      secondRaise = engine.process(frameAt(tick, { spo2Pct: 88 }));
      tick += 1;
    }
    expect(secondRaise).toHaveLength(1);
    expect(secondRaise[0]?.state).toBe("raised");
    expect(secondRaise[0]!.raisedAtMs - (BASE_MS + resolvedAtTick * 1_000)).toBeGreaterThanOrEqual(
      TEST_RULE.cooldownMs,
    );
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 2, resolved: 1, suppressed: 1 });
  });

  it("ends a suppressed episode on recovery; a post-cooldown episode raises normally", () => {
    const engine = new AlertEngine([TEST_RULE]);
    let tick = 0;
    for (const spo2 of [89, 89, 89, 94, 94, 94]) {
      engine.process(frameAt(tick, { spo2Pct: spo2 }));
      tick += 1;
    }
    // Suppressed episode that recovers within the cooldown.
    for (const spo2 of [88, 88, 88, 95, 95, 95]) {
      expect(engine.process(frameAt(tick, { spo2Pct: spo2 }))).toHaveLength(0);
      tick += 1;
    }
    expect(engine.countersFor("unit-dev").suppressed).toBe(1);

    // Fresh episode after the cooldown expired: a normal raise.
    tick = 20;
    const events = [
      ...engine.process(frameAt(tick, { spo2Pct: 89 })),
      ...engine.process(frameAt(tick + 1, { spo2Pct: 89 })),
      ...engine.process(frameAt(tick + 2, { spo2Pct: 89 })),
    ];
    expect(events).toHaveLength(1);
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 2, resolved: 1, suppressed: 1 });
  });

  it("counts suppressed once per genuine episode: a lone breach cannot re-latch", () => {
    const engine = new AlertEngine([TEST_RULE]);
    let tick = 0;
    // Raise, resolve — then a suppressed episode (3 breaches in cooldown).
    for (const spo2 of [89, 89, 89, 94, 94, 94, 88, 88, 88]) {
      engine.process(frameAt(tick, { spo2Pct: spo2 }));
      tick += 1;
    }
    expect(engine.countersFor("unit-dev").suppressed).toBe(1);

    // The latch exits on 3 fresh recoveries; ONE stray breach afterwards must
    // not re-latch — a new episode needs enterCount fresh breaches.
    for (const spo2 of [95, 95, 95, 88]) {
      engine.process(frameAt(tick, { spo2Pct: spo2 }));
      tick += 1;
    }
    expect(engine.countersFor("unit-dev").suppressed).toBe(1);

    // A full second episode inside the cooldown counts exactly once more.
    for (const spo2 of [88, 88]) {
      engine.process(frameAt(tick, { spo2Pct: spo2 }));
      tick += 1;
    }
    expect(engine.countersFor("unit-dev")).toEqual({ raised: 1, resolved: 1, suppressed: 2 });
  });

  it("keeps window time monotonic: a resolve can never be dated before its raise", () => {
    const engine = new AlertEngine([TEST_RULE]);
    engine.process(frameAt(0, { spo2Pct: 89 }));
    engine.process(frameAt(1, { spo2Pct: 89 }));
    const raised = engine.process(frameAt(2, { spo2Pct: 89 }));
    const raisedAtMs = raised[0]!.raisedAtMs;

    // Server clock steps back mid-alert: recoveries arrive with regressed
    // stamps. The monotonic window clock pins resolvedAtMs at >= raisedAtMs.
    let resolved: ReturnType<AlertEngine["process"]> = [];
    for (let i = 0; i < 3; i++) {
      resolved = engine.process({
        ...frameAt(0, { spo2Pct: 95, seq: 10 + i }),
        receivedAtMs: BASE_MS - 5_000 + i,
      });
    }
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolvedAtMs).toBeGreaterThanOrEqual(raisedAtMs);
  });

  it("counts out-of-order and clock-regressed arrivals inside the window", () => {
    const engine = new AlertEngine([TEST_RULE]);
    // capturedAtMs runs backwards; receivedAtMs advances — only the latter
    // matters to the window.
    engine.process(frameAt(0, { spo2Pct: 89, capturedAtMs: BASE_MS + 9_000, seq: 9 }));
    engine.process(frameAt(1, { spo2Pct: 88, capturedAtMs: BASE_MS + 5_000, seq: 5 }));
    // A receive-time regression (server clock nudged back) still counts.
    const raised = engine.process({
      ...frameAt(1, { spo2Pct: 89, capturedAtMs: BASE_MS + 7_000, seq: 7 }),
      receivedAtMs: BASE_MS + 500,
    });
    expect(raised).toHaveLength(1);
    expect(raised[0]?.windowStats.breachCount).toBe(3);
  });

  it("evicts window samples older than windowMs: stale breaches cannot raise", () => {
    const engine = new AlertEngine([TEST_RULE]);
    engine.process(frameAt(0, { spo2Pct: 89 }));
    engine.process(frameAt(1, { spo2Pct: 89 }));
    // 10 s gap: both breaches fall out of the 5 s window.
    const events = engine.process(frameAt(11, { spo2Pct: 89 }));
    expect(events).toHaveLength(0);
    expect(engine.countersFor("unit-dev").raised).toBe(0);
  });

  it("rejects rule configs without hysteresis", () => {
    expect(() => new AlertEngine([{ ...TEST_RULE, exitThreshold: 90 }])).toThrowError(
      /recovered side/,
    );
    expect(
      () =>
        new AlertEngine([
          { ...TEST_RULE, direction: "high", enterThreshold: 150, exitThreshold: 150 },
        ]),
    ).toThrowError(/recovered side/);
    expect(() => new AlertEngine([TEST_RULE, { ...TEST_RULE }])).toThrowError(/duplicate/);
  });
});

/** Run a full sim scenario through the engine with injected receive times. */
function runScenario(options: SimOptions, count: number, rules = DEFAULT_ALERT_RULES) {
  const engine = new AlertEngine(rules);
  const events: { state: string; ruleTick: number; alertId: string }[] = [];
  for (const frame of takeFrames(options, count)) {
    for (const t of engine.process({
      ...frame,
      receivedAtMs: BASE_MS + frame.seq * 1_000,
      sessionEpoch: 1,
    })) {
      events.push({
        state: t.state,
        ruleTick: tickOf(t.state === "resolved" ? (t.resolvedAtMs ?? 0) : t.raisedAtMs),
        alertId: t.alertId,
      });
    }
  }
  return { engine, events };
}

// Transition ticks below are golden-style pins: deterministic products of the
// seeded simulator + DEFAULT_ALERT_RULES, recorded from a verified run. A
// change to either moves them, and this suite is the tripwire.
describe("AlertEngine against vitals-sim scenarios", () => {
  it("rest fires ZERO alerts — the false-alarm baseline is first-class", () => {
    for (const seed of [1, 42]) {
      const { engine, events } = runScenario({ scenario: "rest", seed }, 300);
      expect(events).toHaveLength(0);
      expect(engine.stats).toEqual({ raised: 0, resolved: 0, suppressed: 0 });
    }
  });

  it("motion fires ZERO alerts despite HR excursions and read noise", () => {
    for (const seed of [1, 42]) {
      const { engine, events } = runScenario({ scenario: "motion", seed }, 300);
      expect(events).toHaveLength(0);
      expect(engine.stats).toEqual({ raised: 0, resolved: 0, suppressed: 0 });
    }
  });

  it("anomaly (spike, seed 7): exactly one spo2-low pair, raised tick 89, resolved tick 152", () => {
    const { engine, events } = runScenario({ scenario: "anomaly", seed: 7 }, 220);
    expect(events).toEqual([
      { state: "raised", ruleTick: 89, alertId: "sim-001:spo2-low:1089000:1" },
      { state: "resolved", ruleTick: 152, alertId: "sim-001:spo2-low:1089000:1" },
    ]);
    expect(engine.stats).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
  });

  it("anomaly (suppression, seed 7): hr-low pair (71->119) joins the spo2 pair", () => {
    const { events } = runScenario(
      { scenario: "anomaly", seed: 7, anomaly: { hrExcursion: "suppression" } },
      220,
    );
    expect(events).toEqual([
      { state: "raised", ruleTick: 71, alertId: "sim-001:hr-low:1071000:1" },
      { state: "raised", ruleTick: 89, alertId: "sim-001:spo2-low:1089000:2" },
      { state: "resolved", ruleTick: 119, alertId: "sim-001:hr-low:1071000:1" },
      { state: "resolved", ruleTick: 152, alertId: "sim-001:spo2-low:1089000:2" },
    ]);
  });

  it("a 30-tick anomaly yields ONE raised and ONE resolved event, not 30 alerts", () => {
    const { engine, events } = runScenario(
      { scenario: "anomaly", seed: 7, anomaly: { startTick: 20, durationTicks: 30 } },
      220,
    );
    expect(events.map((e) => ({ state: e.state, ruleTick: e.ruleTick }))).toEqual([
      { state: "raised", ruleTick: 50 },
      { state: "resolved", ruleTick: 102 },
    ]);
    expect(engine.stats).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
  });
});
