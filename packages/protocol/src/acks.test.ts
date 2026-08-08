import { describe, expect, it } from "vitest";

import {
  alertDecisionEventSchema,
  alertDecisionRequestSchema,
  latestDecisions,
  type AlertDecisionEvent,
} from "./acks";
import { streamMessageSchema } from "./stream";

const EVENT: AlertDecisionEvent = {
  eventId: "dev-1:decision:1",
  alertId: "dev-1:spo2-low:1",
  deviceId: "dev-1",
  decision: "acknowledged",
  actor: "web-dashboard",
  recordedAtMs: 1_754_000_100_000,
};

describe("alertDecisionRequestSchema", () => {
  it("takes a decision and an actor, and nothing it did not ask for", () => {
    expect(
      alertDecisionRequestSchema.parse({ decision: "dismissed", actor: "web-dashboard" }),
    ).toEqual({ decision: "dismissed", actor: "web-dashboard" });
    expect(
      alertDecisionRequestSchema.safeParse({ decision: "acknowledged", actor: "a", role: "nurse" })
        .success,
    ).toBe(false);
  });

  it("knows only the two decisions that carry the false-alarm signal", () => {
    expect(alertDecisionRequestSchema.safeParse({ decision: "seen", actor: "a" }).success).toBe(
      false,
    );
    expect(alertDecisionRequestSchema.safeParse({ decision: "acknowledged" }).success).toBe(false);
  });

  it("bounds the note rather than accepting an essay", () => {
    const note = "x".repeat(281);
    expect(
      alertDecisionRequestSchema.safeParse({ decision: "dismissed", actor: "a", note }).success,
    ).toBe(false);
  });
});

describe("alertDecisionEventSchema", () => {
  it("carries who, what, and when", () => {
    expect(alertDecisionEventSchema.parse(EVENT)).toEqual(EVENT);
  });

  it("stays strict, so a forged field cannot ride along into the log", () => {
    expect(alertDecisionEventSchema.safeParse({ ...EVENT, supersedes: "x" }).success).toBe(false);
  });

  it("requires a server timestamp", () => {
    expect(alertDecisionEventSchema.safeParse({ ...EVENT, recordedAtMs: 0 }).success).toBe(false);
  });
});

describe("latestDecisions", () => {
  // The log is append-only against modification: a change of mind is another
  // event, and the reader derives the decision in force rather than the writer
  // overwriting it. It is NOT append-only against deletion — apps/server's
  // DecisionLog evicts its oldest events past a retention bound (C22).
  it("reads the decision in force as the newest event for each alert", () => {
    const dismissed: AlertDecisionEvent = {
      ...EVENT,
      eventId: "dev-1:decision:2",
      decision: "dismissed",
      recordedAtMs: EVENT.recordedAtMs + 5_000,
    };
    const other: AlertDecisionEvent = {
      ...EVENT,
      eventId: "dev-1:decision:3",
      alertId: "dev-1:hr-high:1",
      recordedAtMs: EVENT.recordedAtMs + 1_000,
    };

    const latest = latestDecisions([EVENT, dismissed, other]);

    expect(latest.get(EVENT.alertId)?.decision).toBe("dismissed");
    expect(latest.get(EVENT.alertId)?.eventId).toBe("dev-1:decision:2");
    expect(latest.get("dev-1:hr-high:1")?.decision).toBe("acknowledged");
    expect(latest.size).toBe(2);
  });

  it("is not fooled by an out-of-order log", () => {
    const older: AlertDecisionEvent = {
      ...EVENT,
      eventId: "dev-1:decision:0",
      decision: "dismissed",
      recordedAtMs: EVENT.recordedAtMs - 5_000,
    };
    expect(latestDecisions([EVENT, older]).get(EVENT.alertId)?.decision).toBe("acknowledged");
  });

  it("has nothing in force for an alert nobody judged", () => {
    expect(latestDecisions([]).size).toBe(0);
  });
});

describe("stream fan-out", () => {
  it("carries a decision to every dashboard watching the device", () => {
    expect(streamMessageSchema.parse({ type: "decision", decision: EVENT })).toEqual({
      type: "decision",
      decision: EVENT,
    });
  });

  it("rejects a decision payload that fails the contract", () => {
    expect(
      streamMessageSchema.safeParse({ type: "decision", decision: { ...EVENT, decision: "maybe" } })
        .success,
    ).toBe(false);
  });
});
