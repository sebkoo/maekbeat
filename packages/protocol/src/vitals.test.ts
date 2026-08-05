import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, VITALS_BOUNDS, frameKey, vitalsFrameSchema } from "./index";

const validFrame = {
  v: PROTOCOL_VERSION,
  deviceId: "sim-001",
  seq: 0,
  capturedAtMs: 1_754_400_000_000,
  heartRateBpm: 62,
  spo2Pct: 97.5,
  respirationRpm: 14,
  motion: 0.02,
};

describe("vitalsFrameSchema", () => {
  it("accepts a plausible frame and preserves every field", () => {
    expect(vitalsFrameSchema.parse(validFrame)).toEqual(validFrame);
  });

  it("accepts every lower bound endpoint — a flatline-shaped frame is valid transport", () => {
    const atLowerBounds = {
      ...validFrame,
      heartRateBpm: VITALS_BOUNDS.heartRateBpm.min,
      spo2Pct: VITALS_BOUNDS.spo2Pct.min,
      respirationRpm: VITALS_BOUNDS.respirationRpm.min,
      motion: VITALS_BOUNDS.motion.min,
    };
    expect(vitalsFrameSchema.safeParse(atLowerBounds).success).toBe(true);
  });

  it("accepts every upper bound endpoint", () => {
    const atUpperBounds = {
      ...validFrame,
      heartRateBpm: VITALS_BOUNDS.heartRateBpm.max,
      spo2Pct: VITALS_BOUNDS.spo2Pct.max,
      respirationRpm: VITALS_BOUNDS.respirationRpm.max,
      motion: VITALS_BOUNDS.motion.max,
    };
    expect(vitalsFrameSchema.safeParse(atUpperBounds).success).toBe(true);
  });

  it("rejects unknown keys so corrupted or forged frames cannot pass silently", () => {
    expect(vitalsFrameSchema.safeParse({ ...validFrame, extra: 1 }).success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { motion: _motion, ...withoutMotion } = validFrame;
    expect(vitalsFrameSchema.safeParse(withoutMotion).success).toBe(false);
  });

  it("pins the deviceId length bound at 64 characters", () => {
    expect(vitalsFrameSchema.safeParse({ ...validFrame, deviceId: "d".repeat(64) }).success).toBe(
      true,
    );
    expect(vitalsFrameSchema.safeParse({ ...validFrame, deviceId: "d".repeat(65) }).success).toBe(
      false,
    );
  });

  it("rejects wrong-typed fields", () => {
    expect(vitalsFrameSchema.safeParse({ ...validFrame, heartRateBpm: "62" }).success).toBe(false);
    expect(vitalsFrameSchema.safeParse({ ...validFrame, deviceId: 123 }).success).toBe(false);
    expect(vitalsFrameSchema.safeParse({ ...validFrame, motion: null }).success).toBe(false);
  });

  it.each([
    ["wrong protocol version", { v: 2 }],
    ["empty deviceId", { deviceId: "" }],
    ["negative seq", { seq: -1 }],
    ["fractional seq", { seq: 1.5 }],
    ["epoch-zero capture time", { capturedAtMs: 0 }],
    ["fractional heart rate", { heartRateBpm: 61.5 }],
    ["heart rate below bound", { heartRateBpm: VITALS_BOUNDS.heartRateBpm.min - 1 }],
    ["heart rate above bound", { heartRateBpm: VITALS_BOUNDS.heartRateBpm.max + 1 }],
    ["SpO2 below bound", { spo2Pct: VITALS_BOUNDS.spo2Pct.min - 0.1 }],
    ["SpO2 above bound", { spo2Pct: VITALS_BOUNDS.spo2Pct.max + 0.1 }],
    ["respiration below bound", { respirationRpm: VITALS_BOUNDS.respirationRpm.min - 0.1 }],
    ["respiration above bound", { respirationRpm: VITALS_BOUNDS.respirationRpm.max + 0.1 }],
    ["motion below bound", { motion: VITALS_BOUNDS.motion.min - 0.01 }],
    ["motion above bound", { motion: VITALS_BOUNDS.motion.max + 0.01 }],
  ])("rejects %s", (_name, patch) => {
    expect(vitalsFrameSchema.safeParse({ ...validFrame, ...patch }).success).toBe(false);
  });
});

describe("frameKey", () => {
  it("is identical for a duplicate (deviceId, seq) pair", () => {
    expect(frameKey(validFrame)).toBe(frameKey({ deviceId: "sim-001", seq: 0 }));
  });

  it("differs across seq and across devices", () => {
    expect(frameKey({ deviceId: "sim-001", seq: 1 })).not.toBe(frameKey(validFrame));
    expect(frameKey({ deviceId: "sim-002", seq: 0 })).not.toBe(frameKey(validFrame));
  });
});
