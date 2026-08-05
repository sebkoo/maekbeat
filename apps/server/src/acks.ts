import { latestDecisions, type AlertDecision, type AlertDecisionEvent } from "@maekbeat/protocol";

/**
 * The decision log — append-only by construction, not by convention: there is
 * no update and no delete on this class, so a change of mind is another event
 * and the history of who judged what, when, survives it. That is the shape
 * C22's audit log needs (docs/ROADMAP.md), and the C23 product loop reads
 * acknowledged-against-dismissed straight off it.
 */
export class DecisionLog {
  private readonly byDevice = new Map<string, AlertDecisionEvent[]>();
  private appended = 0;
  private lastRecordedAtMs = 0;

  constructor(
    /** Events kept per device; the oldest are evicted beyond this. */
    private readonly limit = 200,
  ) {}

  append(input: {
    deviceId: string;
    alertId: string;
    decision: AlertDecision;
    actor: string;
    note?: string;
    recordedAtMs: number;
  }): Readonly<AlertDecisionEvent> {
    this.appended += 1;
    // Monotonic per log, the way the alert engine clamps its window clock: a
    // server clock step back must not let an older decision outrank a newer
    // one when `latestDecisions` reads the log.
    const recordedAtMs = Math.max(input.recordedAtMs, this.lastRecordedAtMs);
    this.lastRecordedAtMs = recordedAtMs;
    const event: AlertDecisionEvent = {
      eventId: `${input.deviceId}:decision:${this.appended}`,
      alertId: input.alertId,
      deviceId: input.deviceId,
      decision: input.decision,
      actor: input.actor,
      recordedAtMs,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    // Frozen, so "no update" is a property of the object and not a promise
    // about its callers.
    Object.freeze(event);

    const log = this.byDevice.get(input.deviceId) ?? [];
    log.push(event);
    // Eviction is a retention bound, not an edit: the oldest events leave in
    // the order they arrived, and nothing already written is ever changed.
    if (log.length > this.limit) log.splice(0, log.length - this.limit);
    this.byDevice.set(input.deviceId, log);
    return event;
  }

  /**
   * Whether any decision has been recorded for this alert. The alert engine
   * asks this when it must evict (apps/server/src/alerts.ts): a triaged alert
   * is the one safe thing to forget.
   */
  isDecided(deviceId: string, alertId: string): boolean {
    return (this.byDevice.get(deviceId) ?? []).some((event) => event.alertId === alertId);
  }

  /** The device's log, oldest first; the events themselves are frozen. */
  list(deviceId: string): ReadonlyArray<Readonly<AlertDecisionEvent>> {
    return [...(this.byDevice.get(deviceId) ?? [])];
  }

  /**
   * Decisions in force, counted by kind — the C23 false-alarm signal. Derived
   * with the same `latestDecisions` the dashboard uses, so one function defines
   * "in force" at both ends and a clock step cannot make the counter and the
   * row disagree.
   */
  countsFor(deviceId: string): { acknowledged: number; dismissed: number } {
    let acknowledged = 0;
    let dismissed = 0;
    for (const event of latestDecisions(this.byDevice.get(deviceId) ?? []).values()) {
      if (event.decision === "acknowledged") acknowledged += 1;
      else dismissed += 1;
    }
    return { acknowledged, dismissed };
  }
}
