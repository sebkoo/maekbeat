import { describe, expect, it } from "vitest";

import { alertEventSchema } from "./alerts";
import { deviceSilenceEventSchema, SILENCE_RULE_ID, type DeviceSilenceEvent } from "./silence";
import { streamMessageSchema } from "./stream";

function validEvent(overrides: Partial<DeviceSilenceEvent> = {}): DeviceSilenceEvent {
  return {
    alertId: `dev-a:${SILENCE_RULE_ID}:1000:1`,
    deviceId: "dev-a",
    kind: "silence",
    state: "raised",
    raisedAtMs: 1_000,
    lastFrameAtMs: 955,
    thresholdMs: 45_000,
    silentForMs: 45_045,
    sessionEpoch: 1,
    ...overrides,
  };
}

describe("deviceSilenceEventSchema", () => {
  it("parses an open episode without resolvedAtMs", () => {
    expect(deviceSilenceEventSchema.parse(validEvent())).toEqual(validEvent());
  });

  it("parses a resolved episode with resolvedAtMs", () => {
    const resolved = validEvent({ state: "resolved", resolvedAtMs: 61_000 });
    expect(deviceSilenceEventSchema.parse(resolved)).toEqual(resolved);
  });

  it("stays strict — an unknown key is a corrupted payload, not a new feature", () => {
    expect(deviceSilenceEventSchema.safeParse({ ...validEvent(), metric: "spo2Pct" }).success).toBe(
      false,
    );
  });

  it("rejects a resolve dated before its raise", () => {
    const inverted = validEvent({ state: "resolved", resolvedAtMs: 999 });
    expect(deviceSilenceEventSchema.safeParse(inverted).success).toBe(false);
  });

  it("accepts a silence of zero length but not a negative one", () => {
    expect(deviceSilenceEventSchema.safeParse(validEvent({ silentForMs: 0 })).success).toBe(true);
    expect(deviceSilenceEventSchema.safeParse(validEvent({ silentForMs: -1 })).success).toBe(false);
  });

  it("shares the alert lifecycle rather than restating it", () => {
    for (const state of ["raised", "ongoing", "resolved"] as const) {
      expect(deviceSilenceEventSchema.safeParse(validEvent({ state })).success).toBe(true);
    }
    expect(
      deviceSilenceEventSchema.safeParse(validEvent({ state: "snoozed" as never })).success,
    ).toBe(false);
  });

  /*
   * The separation is the design decision (src/silence.ts), so it is asserted
   * rather than left in prose: neither schema accepts the other's record. If
   * they ever converged, the convergence would have to be a metric invented
   * for an event where no metric was measured.
   */
  it("is not an alert event, and an alert event is not one of these", () => {
    expect(alertEventSchema.safeParse(validEvent()).success).toBe(false);
    expect(
      deviceSilenceEventSchema.safeParse({
        alertId: "dev-a:spo2-low:1000:1",
        deviceId: "dev-a",
        metric: "spo2Pct",
        direction: "low",
        state: "raised",
        raisedAtMs: 1_000,
        windowStats: {
          windowMs: 15_000,
          sampleCount: 12,
          breachCount: 5,
          minValue: 87,
          maxValue: 91,
        },
      }).success,
    ).toBe(false);
  });

  it("names a rule id the server's alertId format can carry", () => {
    // apps/server/src/alerts.ts RULE_ID_PATTERN, restated as the constraint it
    // is: a rule id that cannot round-trip through an alertId is an alert
    // nobody can ever acknowledge.
    expect(SILENCE_RULE_ID).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("streamMessageSchema", () => {
  it("carries a silence message end to end", () => {
    const message = { type: "silence" as const, silence: validEvent() };
    expect(streamMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a silence message whose payload is an alert event", () => {
    expect(
      streamMessageSchema.safeParse({
        type: "silence",
        silence: {
          alertId: "dev-a:spo2-low:1000:1",
          deviceId: "dev-a",
          metric: "spo2Pct",
          direction: "low",
          state: "raised",
          raisedAtMs: 1_000,
          windowStats: {
            windowMs: 15_000,
            sampleCount: 12,
            breachCount: 5,
            minValue: 87,
            maxValue: 91,
          },
        },
      }).success,
    ).toBe(false);
  });
});
