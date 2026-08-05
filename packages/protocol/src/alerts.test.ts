import { describe, expect, it } from "vitest";

import { alertEventSchema, type AlertEvent } from "./alerts";

function validEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    alertId: "dev-a:spo2-low:1000",
    deviceId: "dev-a",
    metric: "spo2Pct",
    direction: "low",
    state: "raised",
    raisedAtMs: 1_000,
    windowStats: {
      windowMs: 15_000,
      sampleCount: 12,
      breachCount: 5,
      minValue: 87.5,
      maxValue: 91.2,
    },
    ...overrides,
  };
}

describe("alertEventSchema", () => {
  it("parses a raised event without resolvedAtMs", () => {
    expect(alertEventSchema.parse(validEvent())).toEqual(validEvent());
  });

  it("parses a resolved event with resolvedAtMs", () => {
    const resolved = validEvent({ state: "resolved", resolvedAtMs: 60_000 });
    expect(alertEventSchema.parse(resolved)).toEqual(resolved);
  });

  it("rejects unknown keys — the schema is strict like the vitals frame", () => {
    expect(alertEventSchema.safeParse({ ...validEvent(), acknowledged: true }).success).toBe(false);
  });

  it("rejects unknown states, metrics, and directions", () => {
    expect(alertEventSchema.safeParse(validEvent({ state: "snoozed" as never })).success).toBe(
      false,
    );
    expect(alertEventSchema.safeParse(validEvent({ metric: "motion" as never })).success).toBe(
      false,
    );
    expect(alertEventSchema.safeParse(validEvent({ direction: "sideways" as never })).success).toBe(
      false,
    );
  });

  it("rejects malformed window stats", () => {
    const negative = validEvent();
    negative.windowStats = { ...negative.windowStats, breachCount: -1 };
    expect(alertEventSchema.safeParse(negative).success).toBe(false);

    const empty = validEvent();
    empty.windowStats = { ...empty.windowStats, sampleCount: 0 };
    expect(alertEventSchema.safeParse(empty).success).toBe(false);
  });

  it("rejects a resolve dated before its raise", () => {
    expect(
      alertEventSchema.safeParse(
        validEvent({ state: "resolved", raisedAtMs: 60_000, resolvedAtMs: 59_999 }),
      ).success,
    ).toBe(false);
    expect(
      alertEventSchema.safeParse(
        validEvent({ state: "resolved", raisedAtMs: 60_000, resolvedAtMs: 60_000 }),
      ).success,
    ).toBe(true);
  });

  it("rejects non-positive timestamps", () => {
    expect(alertEventSchema.safeParse(validEvent({ raisedAtMs: 0 })).success).toBe(false);
    expect(
      alertEventSchema.safeParse(validEvent({ state: "resolved", resolvedAtMs: -5 })).success,
    ).toBe(false);
  });
});
