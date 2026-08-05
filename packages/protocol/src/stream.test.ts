import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, vitalsFrameSchema } from "./vitals";
import { storedVitalsFrameSchema, streamMessageSchema } from "./stream";

const FRAME = {
  v: PROTOCOL_VERSION,
  deviceId: "dev-1",
  seq: 12,
  capturedAtMs: 1_754_000_012_000,
  heartRateBpm: 72,
  spo2Pct: 97.5,
  respirationRpm: 14.2,
  motion: 0.12,
};

const STORED = { ...FRAME, receivedAtMs: 1_754_000_012_310, sessionEpoch: 1 };

const ALERT = {
  alertId: "dev-1:spo2-low:1",
  deviceId: "dev-1",
  metric: "spo2Pct" as const,
  direction: "low" as const,
  state: "raised" as const,
  raisedAtMs: 1_754_000_040_000,
  windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
};

describe("storedVitalsFrameSchema", () => {
  it("is the wire frame plus exactly the two server stamps", () => {
    expect(storedVitalsFrameSchema.parse(STORED)).toEqual(STORED);
    expect(vitalsFrameSchema.safeParse(STORED).success).toBe(false);
  });

  it("stays strict — an unknown key is a corrupted payload, not a new feature", () => {
    expect(storedVitalsFrameSchema.safeParse({ ...STORED, bloodPressure: 120 }).success).toBe(
      false,
    );
  });

  it("requires both stamps", () => {
    expect(storedVitalsFrameSchema.safeParse(FRAME).success).toBe(false);
    expect(storedVitalsFrameSchema.safeParse({ ...STORED, sessionEpoch: 0 }).success).toBe(false);
  });
});

describe("streamMessageSchema", () => {
  it("accepts the three fan-out messages", () => {
    const ready = {
      type: "ready" as const,
      deviceId: "dev-1",
      serverTimeMs: 1_754_000_000_000,
      ringCapacity: 1024,
    };
    expect(streamMessageSchema.parse(ready)).toEqual(ready);
    expect(streamMessageSchema.parse({ type: "frame", frame: STORED })).toEqual({
      type: "frame",
      frame: STORED,
    });
    expect(streamMessageSchema.parse({ type: "alert", alert: ALERT })).toEqual({
      type: "alert",
      alert: ALERT,
    });
  });

  it("rejects an unknown message type rather than passing it through", () => {
    expect(streamMessageSchema.safeParse({ type: "heartbeat" }).success).toBe(false);
  });

  it("validates the payload inside the envelope", () => {
    expect(
      streamMessageSchema.safeParse({ type: "frame", frame: { ...STORED, spo2Pct: 140 } }).success,
    ).toBe(false);
    expect(
      streamMessageSchema.safeParse({
        type: "alert",
        alert: { ...ALERT, resolvedAtMs: ALERT.raisedAtMs - 1 },
      }).success,
    ).toBe(false);
  });

  it("keeps the protocol version at 1 — this addition is additive", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(vitalsFrameSchema.parse(FRAME)).toEqual(FRAME);
  });
});
