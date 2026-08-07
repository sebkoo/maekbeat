import { z } from "zod";

import { alertStateSchema } from "./alerts";

/*
 * Device silence (C20a). The fourth additive exercise of the evolution policy:
 * new schemas only, the vitals frame untouched, protocol version stays 1.
 *
 * Why this is not an `alertEventSchema`, which is the obvious thing to reach
 * for and the wrong one. A threshold alert is a claim about a value: it has a
 * metric, a direction, a window, and a min and a max inside that window.
 * Silence is a claim about the absence of frames, and it has none of those.
 * `alertMetricSchema` is `heartRateBpm | spo2Pct | respirationRpm`, so putting
 * silence inside `alertEventSchema` means either widening that enum or picking
 * one of the three — and picking one produces a record that says a heart rate
 * crossed a threshold when what happened is that nothing arrived at all. That
 * is H8 in docs/regulatory/hazard-analysis.md, a notification saying more than
 * the data supports, manufactured on purpose to save a schema.
 *
 * What the two records do share is the lifecycle (`alertStateSchema`, imported
 * rather than restated) and the `alertId` format, so one decision route judges
 * both and a caregiver acknowledges a silent device the same way they
 * acknowledge a desaturation.
 */

/**
 * One episode of a device sending nothing, through its lifecycle.
 *
 * Every timestamp is server receive time, never device clock — a device that
 * has stopped sending has stopped stamping too, so its clock is the one thing
 * this record can never be built from (docs/ARCHITECTURE.md).
 */
export const deviceSilenceEventSchema = z
  .strictObject({
    /**
     * The same format threshold alerts use, `<deviceId>:<ruleId>:<raisedAtMs>:
     * <ordinal>`, with the rule id below. Shared so that the acknowledgement
     * route parses one kind of handle rather than two.
     */
    alertId: z.string().min(1),
    deviceId: z.string().min(1).max(64),
    /**
     * A literal rather than an inference. A reader with one of these in hand
     * must be able to say what it is without knowing which array it came out
     * of, because it also arrives alone over the fan-out socket.
     */
    kind: z.literal("silence"),
    /** raised → ongoing → resolved, the same three states an alert has. */
    state: alertStateSchema,
    /** When the sweep judged the device silent, not when it fell silent. */
    raisedAtMs: z.int().positive(),
    /** When a frame arrived and ended it; absent while the device is quiet. */
    resolvedAtMs: z.int().positive().optional(),
    /** Receive time of the last frame before the silence: when it fell quiet. */
    lastFrameAtMs: z.int().positive(),
    /** The threshold in force when this was raised, so the record explains itself. */
    thresholdMs: z.int().positive(),
    /**
     * Length of the gap at the last evaluation, and its final length once
     * resolved. Kept as a field rather than left to be subtracted, because
     * while the episode is open there is no second timestamp to subtract from.
     */
    silentForMs: z.int().nonnegative(),
    /** The session epoch that went quiet (apps/server/src/store.ts). */
    sessionEpoch: z.int().positive(),
  })
  .refine((event) => event.resolvedAtMs === undefined || event.resolvedAtMs >= event.raisedAtMs, {
    message: "resolvedAtMs must not precede raisedAtMs",
    path: ["resolvedAtMs"],
  });
export type DeviceSilenceEvent = z.infer<typeof deviceSilenceEventSchema>;

/**
 * The rule id inside every silence `alertId`. It satisfies apps/server's
 * `RULE_ID_PATTERN`, and it is exported here rather than in the server because
 * a client parsing an id has to be able to tell the two kinds apart without
 * asking the server which rules it happens to be running.
 */
export const SILENCE_RULE_ID = "device-silent";
