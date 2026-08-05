import { z } from "zod";

// First live exercise of the evolution policy: an ADDITIVE type — new schema
// export, no change to the vitals frame, protocol version stays 1. Receivers
// that predate it are unaffected.

/** Vital fields an alert rule can watch — a subset of the frame's metrics. */
export const alertMetricSchema = z.enum(["heartRateBpm", "spo2Pct", "respirationRpm"]);
export type AlertMetric = z.infer<typeof alertMetricSchema>;

/** Lifecycle: raised (just fired) → ongoing (still active) → resolved. */
export const alertStateSchema = z.enum(["raised", "ongoing", "resolved"]);
export type AlertState = z.infer<typeof alertStateSchema>;

/**
 * Stats over the sliding window that judged the alert, captured at the last
 * evaluation. Timestamps around the window are server receive time — the
 * clock policy of docs/ARCHITECTURE.md (drift shifts charts, never alerts).
 */
export const alertWindowStatsSchema = z.strictObject({
  windowMs: z.int().positive(),
  sampleCount: z.int().positive(),
  breachCount: z.int().nonnegative(),
  minValue: z.number(),
  maxValue: z.number(),
});
export type AlertWindowStats = z.infer<typeof alertWindowStatsSchema>;

/**
 * One alert through its lifecycle. `alertId` is stable across state changes —
 * the acknowledgement handle for the C12 dashboard and the C23 product loop.
 * `raisedAtMs`/`resolvedAtMs` are server clock (receive time), never device
 * clock.
 */
export const alertEventSchema = z
  .strictObject({
    alertId: z.string().min(1),
    deviceId: z.string().min(1).max(64),
    metric: alertMetricSchema,
    direction: z.enum(["low", "high"]),
    state: alertStateSchema,
    raisedAtMs: z.int().positive(),
    resolvedAtMs: z.int().positive().optional(),
    windowStats: alertWindowStatsSchema,
  })
  .refine((event) => event.resolvedAtMs === undefined || event.resolvedAtMs >= event.raisedAtMs, {
    message: "resolvedAtMs must not precede raisedAtMs",
    path: ["resolvedAtMs"],
  });
export type AlertEvent = z.infer<typeof alertEventSchema>;
