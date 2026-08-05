import type { StoredVitalsFrame } from "@maekbeat/protocol";
import { describe, expect, it, vi } from "vitest";

import { DecisionLog } from "./acks";
import {
  AlertEngine,
  ALERT_HISTORY_LIMIT,
  alertIdFor,
  parseAlertId,
  type AlertRuleConfig,
} from "./alerts";

/*
 * Retention with a judgement in it (docs/DECISIONS.md #15). The alert history
 * stays bounded — memory per device must not grow with uptime — but eviction
 * drops triaged alerts before untriaged ones, because discarding an alert
 * nobody has seen is the system throwing away exactly the thing a caregiver
 * has not yet read. When only undecided alerts remain the bound still wins,
 * and that loss is counted rather than hidden.
 */

/** A rule that raises on the first breaching sample and resolves immediately. */
const TWITCHY: AlertRuleConfig = {
  id: "spo2-low",
  metric: "spo2Pct",
  direction: "low",
  enterThreshold: 90,
  // Hysteresis is structural in this engine: the exit threshold must sit on
  // the recovered side of the enter threshold (apps/server/src/alerts.ts).
  exitThreshold: 95,
  enterCount: 1,
  exitCount: 1,
  windowMs: 1_000,
  cooldownMs: 0,
};

function frame(
  seq: number,
  spo2Pct: number,
  receivedAtMs: number,
  heartRateBpm = 70,
): StoredVitalsFrame {
  return {
    v: 1,
    deviceId: "dev-1",
    seq,
    capturedAtMs: 1_754_000_000_000 + seq,
    heartRateBpm,
    spo2Pct,
    respirationRpm: 14,
    motion: 0.1,
    receivedAtMs,
    sessionEpoch: 1,
  };
}

/**
 * Raises `count` separate spo2 episodes, oldest first. `heartRateBpm` is held
 * across every frame so a second rule can be kept open — or left alone — for
 * the whole run.
 */
function raiseEpisodes(engine: AlertEngine, count: number, heartRateBpm = 70) {
  let receivedAtMs = 1_000;
  for (let i = 0; i < count; i++) {
    engine.process(frame(i * 2, 80, receivedAtMs, heartRateBpm));
    receivedAtMs += 2_000;
    engine.process(frame(i * 2 + 1, 99, receivedAtMs, heartRateBpm));
    receivedAtMs += 2_000;
  }
}

describe("alertId", () => {
  it("round-trips through minting and parsing", () => {
    const id = alertIdFor("dev-1", "spo2-low", 1_754_000_000_000, 7);
    expect(id).toBe("dev-1:spo2-low:1754000000000:7");
    expect(parseAlertId(id)).toEqual({
      deviceId: "dev-1",
      ruleId: "spo2-low",
      raisedAtMs: 1_754_000_000_000,
      ordinal: 7,
    });
  });

  // A deviceId may itself contain colons, so the id is read from the right.
  it("reads a device id that contains colons", () => {
    const id = alertIdFor("ward:3:bed:2", "hr-high", 1_754_000_000_000, 1);
    expect(parseAlertId(id)?.deviceId).toBe("ward:3:bed:2");
    expect(parseAlertId(id)?.ruleId).toBe("hr-high");
  });

  it("refuses anything that is not one", () => {
    for (const bad of [
      "ghost",
      "dev-1:spo2-low:1754000000000",
      "dev-1:spo2-low:not-a-number:1",
      "dev-1:spo2-low:1754000000000:0",
      "dev-1:SPO2:1754000000000:1",
      ":spo2-low:1754000000000:1",
      `${"d".repeat(65)}:spo2-low:1754000000000:1`,
      // Spellings Number() would happily accept and alertIdFor can never mint.
      // Each would record a decision whose string never matches the alert it
      // was meant to judge — an alert left undecided, evictable, and counted.
      "dev-1:spo2-low: 1754000000000: 1",
      "dev-1:spo2-low:0x1988a9a4400:0x1",
      "dev-1:spo2-low:1.754e12:1",
      "dev-1:spo2-low:+1754000000000:+1",
      "dev-1:spo2-low:1754000000000:1.0",
    ]) {
      expect(parseAlertId(bad), bad).toBeUndefined();
    }
  });

  // Whatever the engine can mint, the decision route must be able to read.
  it("round-trips every id the engine can mint", () => {
    const devices = ["d", "dev-1", "ward:3:bed:2", "d".repeat(64), "dev.1_2"];
    const rules = ["spo2-low", "hr-high", "a", "rule-9"];
    for (const deviceId of devices) {
      for (const ruleId of rules) {
        for (const raisedAtMs of [1, 1_754_000_000_000, Number.MAX_SAFE_INTEGER - 1]) {
          for (const ordinal of [1, 7, 1_000_000]) {
            const id = alertIdFor(deviceId, ruleId, raisedAtMs, ordinal);
            expect(parseAlertId(id), id).toEqual({ deviceId, ruleId, raisedAtMs, ordinal });
          }
        }
      }
    }
  });
});

describe("alert history eviction", () => {
  it("drops a decided alert before any undecided one", () => {
    const decisions = new DecisionLog();
    const engine = new AlertEngine([TWITCHY], {
      isDecided: (deviceId, alertId) => decisions.isDecided(deviceId, alertId),
    });

    raiseEpisodes(engine, ALERT_HISTORY_LIMIT);
    const before = engine.listAlerts("dev-1");
    expect(before).toHaveLength(ALERT_HISTORY_LIMIT);

    // Triage one in the middle; it is now the safe thing to forget.
    const triaged = before[40]!;
    decisions.append({
      deviceId: "dev-1",
      alertId: triaged.alertId,
      decision: "acknowledged",
      actor: "nurse-station",
      recordedAtMs: 1,
    });

    raiseEpisodes(engine, 1);

    const after = engine.listAlerts("dev-1");
    expect(after).toHaveLength(ALERT_HISTORY_LIMIT);
    expect(after.some((alert) => alert.alertId === triaged.alertId)).toBe(false);
    // The oldest — untriaged — is still there, which is the whole point.
    expect(after.some((alert) => alert.alertId === before[0]!.alertId)).toBe(true);
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(0);
  });

  it("drops the oldest decided alert when several have been triaged", () => {
    const decisions = new DecisionLog();
    const engine = new AlertEngine([TWITCHY], {
      isDecided: (deviceId, alertId) => decisions.isDecided(deviceId, alertId),
    });
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT);
    const before = engine.listAlerts("dev-1");

    for (const index of [10, 60]) {
      decisions.append({
        deviceId: "dev-1",
        alertId: before[index]!.alertId,
        decision: "dismissed",
        actor: "nurse-station",
        recordedAtMs: 1,
      });
    }

    raiseEpisodes(engine, 1);

    const after = engine.listAlerts("dev-1");
    expect(after.some((alert) => alert.alertId === before[10]!.alertId)).toBe(false);
    expect(after.some((alert) => alert.alertId === before[60]!.alertId)).toBe(true);
  });

  // An episode someone acknowledged while it was still running is the one
  // being acted on; forgetting it would also orphan its later resolve event.
  it("keeps an acknowledged episode that is still running", () => {
    const decisions = new DecisionLog();
    // A second rule so one episode can stay open while the other keeps
    // raising: a rule with an active alert cannot raise again by design.
    const HR_HIGH = {
      ...TWITCHY,
      id: "hr-high",
      metric: "heartRateBpm" as const,
      direction: "high" as const,
      enterThreshold: 150,
      exitThreshold: 130,
    };
    const engine = new AlertEngine([TWITCHY, HR_HIGH], {
      isDecided: (deviceId, alertId) => decisions.isDecided(deviceId, alertId),
    });

    // The open episode is raised FIRST, so it is the oldest decided alert in
    // the history: an implementation that only asks "is it decided?" would
    // reach it before the resolved one and drop the wrong alert.
    engine.process(frame(0, 97, 500, 190));
    const ongoing = engine.listAlerts("dev-1")[0]!;
    expect(ongoing.state).not.toBe("resolved");

    // Heart rate stays high throughout, so that episode never recovers.
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT - 1, 190);
    expect(engine.listAlerts("dev-1")).toHaveLength(ALERT_HISTORY_LIMIT);
    const resolvedAndDecided = engine.listAlerts("dev-1")[50]!;
    expect(resolvedAndDecided.state).toBe("resolved");
    for (const alert of [ongoing, resolvedAndDecided]) {
      decisions.append({
        deviceId: "dev-1",
        alertId: alert.alertId,
        decision: "acknowledged",
        actor: "nurse-station",
        recordedAtMs: 1,
      });
    }

    raiseEpisodes(engine, 1, 190);

    const after = engine.listAlerts("dev-1");
    expect(after.find((alert) => alert.alertId === ongoing.alertId)?.state).not.toBe("resolved");
    expect(after.some((alert) => alert.alertId === resolvedAndDecided.alertId)).toBe(false);
  });

  // The bound is real: when nothing has been triaged, something still goes.
  it("counts and announces a forced eviction when nothing has been triaged", () => {
    const onForcedEviction = vi.fn();
    const engine = new AlertEngine([TWITCHY], { onForcedEviction });

    raiseEpisodes(engine, ALERT_HISTORY_LIMIT);
    const oldest = engine.listAlerts("dev-1")[0]!;
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(0);

    raiseEpisodes(engine, 1);

    expect(engine.listAlerts("dev-1")).toHaveLength(ALERT_HISTORY_LIMIT);
    expect(engine.listAlerts("dev-1").some((a) => a.alertId === oldest.alertId)).toBe(false);
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(1);
    expect(engine.stats.forcedEvictions).toBe(1);
    expect(onForcedEviction).toHaveBeenCalledWith({
      deviceId: "dev-1",
      alertId: oldest.alertId,
    });
  });

  it("keeps counting as a full undecided backlog keeps forcing drops", () => {
    const engine = new AlertEngine([TWITCHY]);
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT + 5);

    expect(engine.listAlerts("dev-1")).toHaveLength(ALERT_HISTORY_LIMIT);
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(5);
  });

  it("never evicts, counts, or announces while the history has room", () => {
    const onForcedEviction = vi.fn();
    const engine = new AlertEngine([TWITCHY], { onForcedEviction });
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT);

    expect(engine.listAlerts("dev-1")).toHaveLength(ALERT_HISTORY_LIMIT);
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(0);
    // The warn means "nobody is triaging"; firing it on a healthy eviction
    // would make the one operational signal here meaningless.
    expect(onForcedEviction).not.toHaveBeenCalled();
  });

  it("announces nothing when a decided alert is the one dropped", () => {
    const decisions = new DecisionLog();
    const onForcedEviction = vi.fn();
    const engine = new AlertEngine([TWITCHY], {
      isDecided: (deviceId, alertId) => decisions.isDecided(deviceId, alertId),
      onForcedEviction,
    });
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT);
    decisions.append({
      deviceId: "dev-1",
      alertId: engine.listAlerts("dev-1")[0]!.alertId,
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 1,
    });

    raiseEpisodes(engine, 1);

    expect(onForcedEviction).not.toHaveBeenCalled();
    expect(engine.countersFor("dev-1").forcedEvictions).toBe(0);
  });

  it("refuses a rule id that could not appear in an alertId", () => {
    for (const id of ["SpO2_Low", "hr:high", "spo2 low", ""]) {
      expect(() => new AlertEngine([{ ...TWITCHY, id }]), id).toThrow(RangeError);
    }
  });

  it("asks about the device it is evicting for, not just the alert", () => {
    const asked: Array<[string, string]> = [];
    const engine = new AlertEngine([TWITCHY], {
      isDecided: (deviceId, alertId) => {
        asked.push([deviceId, alertId]);
        return false;
      },
    });
    raiseEpisodes(engine, ALERT_HISTORY_LIMIT + 1);

    expect(asked.length).toBeGreaterThan(0);
    for (const [deviceId] of asked) expect(deviceId).toBe("dev-1");
  });
});
