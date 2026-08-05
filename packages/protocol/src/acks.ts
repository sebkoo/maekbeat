import { z } from "zod";

/*
 * Alert acknowledgement (C12). The third additive exercise of the evolution
 * policy: new schemas only, the vitals frame untouched, protocol version 1.
 *
 * Shaped as an append-only event, not as a mutable field on the alert. An
 * acknowledgement is something a person did at a time, so it is recorded and
 * never edited; the current decision for an alert is derived by reading the
 * latest event for its `alertId`. That is the shape C22's audit log needs, and
 * building it now costs nothing that retrofitting it later would not cost more.
 */

/**
 * The distinction that carries the signal: `acknowledged` means seen and acted
 * on, `dismissed` means seen and judged not actionable. Counting the second
 * against the first is the false-alarm rate the C23 product loop asks for —
 * one number that a client-side checkbox could never produce.
 */
export const alertDecisionSchema = z.enum(["acknowledged", "dismissed"]);
export type AlertDecision = z.infer<typeof alertDecisionSchema>;

/** What a client sends to record a decision. */
export const alertDecisionRequestSchema = z.strictObject({
  decision: alertDecisionSchema,
  /**
   * Who acted, as asserted by the caller. There is no authentication in this
   * system (apps/server README, "Declared limits"), so this is provenance, not
   * identity — C22 owns making it a claim anyone should trust.
   */
  actor: z.string().min(1).max(64),
  note: z.string().max(280).optional(),
});
export type AlertDecisionRequest = z.infer<typeof alertDecisionRequestSchema>;

/** One appended decision, as the server records and serves it. */
export const alertDecisionEventSchema = z.strictObject({
  /** Unique per appended event — two decisions on one alert are two events. */
  eventId: z.string().min(1),
  alertId: z.string().min(1),
  deviceId: z.string().min(1).max(64),
  decision: alertDecisionSchema,
  actor: z.string().min(1).max(64),
  /** Server clock at append — the same receive-time rule alerts follow. */
  recordedAtMs: z.int().positive(),
  note: z.string().max(280).optional(),
});
export type AlertDecisionEvent = z.infer<typeof alertDecisionEventSchema>;

/**
 * The decision in force for an alert: the latest event for it, or none. Derived
 * rather than stored, so the log stays the only writable thing.
 */
export function latestDecisions(
  events: readonly AlertDecisionEvent[],
): Map<string, AlertDecisionEvent> {
  const latest = new Map<string, AlertDecisionEvent>();
  for (const event of events) {
    const held = latest.get(event.alertId);
    if (held === undefined || event.recordedAtMs >= held.recordedAtMs) {
      latest.set(event.alertId, event);
    }
  }
  return latest;
}
