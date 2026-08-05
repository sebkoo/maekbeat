import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Transport-validity bounds — the sensor-representable range, NOT clinical thresholds.
// A frame with HR 15 or SpO2 45 is exactly what the pipeline exists to surface, so the
// schema rejects only malformed readings; severity judgment belongs to the alert engine (C7).
export const VITALS_BOUNDS = {
  heartRateBpm: { min: 0, max: 300 },
  spo2Pct: { min: 0, max: 100 },
  respirationRpm: { min: 0, max: 120 },
  motion: { min: 0, max: 1 },
} as const;

export const vitalsFrameSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  deviceId: z.string().min(1).max(64),
  seq: z.int().nonnegative(),
  capturedAtMs: z.int().positive(),
  heartRateBpm: z.int().min(VITALS_BOUNDS.heartRateBpm.min).max(VITALS_BOUNDS.heartRateBpm.max),
  spo2Pct: z.number().min(VITALS_BOUNDS.spo2Pct.min).max(VITALS_BOUNDS.spo2Pct.max),
  respirationRpm: z
    .number()
    .min(VITALS_BOUNDS.respirationRpm.min)
    .max(VITALS_BOUNDS.respirationRpm.max),
  motion: z.number().min(VITALS_BOUNDS.motion.min).max(VITALS_BOUNDS.motion.max),
});

export type VitalsFrame = z.infer<typeof vitalsFrameSchema>;

// Dedupe key for the duplicate-packets failure mode: at most one frame per (deviceId, seq).
export function frameKey(frame: Pick<VitalsFrame, "deviceId" | "seq">): string {
  return `${frame.deviceId}#${frame.seq}`;
}
