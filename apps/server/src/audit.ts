/**
 * The audit log — a BOUNDED ring of recent events plus MONOTONIC counters that
 * eviction cannot touch. Both halves are named in the first sentence because
 * the commit before this one existed to correct a class whose docstring called
 * it append-only three lines above the splice that deletes.
 *
 * WHY TWO HALVES AND NOT ONE RING. A bounded log that records forced evictions
 * and dropped subscribers loses exactly the events that matter when either
 * actually happens: a flood forces evictions, the evictions are recorded, and
 * the flood pushes the record of itself out of the ring. The detector would
 * inherit the blind spot of the thing it detects, and it would be honest only
 * while nothing was wrong.
 *
 * So `totals()` never decreases and is never spliced. Under a flood the ring
 * shows the tail and the counters show the flood: detail degrades, the fact
 * does not. That composition is asserted in one test rather than in two —
 * src/audit.test.ts floods past the bound and checks that entries were evicted
 * AND that the counters kept counting through the eviction, because a unit
 * proving its own behaviour is what this repository already has and is not what
 * fails here.
 *
 * WHAT IS RECORDED, AND THE WORD IS RECORDED. Nothing in this repository reads
 * this log except its tests. There is no route, no view, and no alert. A person
 * cannot act on any of it today, so the claim is that these events are recorded
 * and NOT that they are detectable — those are different words and the
 * difference is whether anybody could ever see it. The read path is owed and is
 * recorded as owed in docs/regulatory/hazard-analysis.md rather than implied
 * away here.
 *
 * GRANULARITY IS STATE CHANGES, NOT TRAFFIC. Frames arrive continuously; a log
 * that recorded every ingest would be a firehose and the first thing anyone
 * deleted. What lands here is a bounded store discarding something, or a
 * subscriber being dropped — events that are already rare because something
 * else already bounds them.
 *
 * WHAT THIS DOES NOT REACH. TH1 in docs/security/threat-model.md is injected
 * frames, and nothing here records them: a forged frame is byte-identical to a
 * legitimate one and only per-frame provenance would separate them, which does
 * not exist. This records TH4's forced evictions and TH5's dropped subscribers.
 * It prevents none of the five — prevention at those boundaries is
 * authentication, which is a different commit and arguably a different row.
 */

/** The state changes worth a line. Deliberately not per-frame. */
export type AuditKind = "alert.evicted" | "silence.evicted" | "stream.dropped";

export interface AuditEvent {
  /** Monotonic across the log's life, so a gap in the ring is visible as one. */
  readonly seq: number;
  readonly kind: AuditKind;
  readonly deviceId: string;
  readonly recordedAtMs: number;
  readonly detail: string;
}

export interface AuditTotals {
  /** Every event ever recorded. Never decreases. */
  readonly recorded: number;
  /** Events pushed out of the ring. Never decreases. */
  readonly evicted: number;
  /** What the ring holds now. Bounded by the limit. */
  readonly retained: number;
  readonly byKind: Readonly<Record<AuditKind, number>>;
}

/** Ring size. 500 is a tail, not a history; the counters are the history. */
export const AUDIT_RING_LIMIT = 500;

export class AuditLog {
  private readonly ring: AuditEvent[] = [];
  private recorded = 0;
  private evicted = 0;
  private lastRecordedAtMs = 0;
  private readonly byKind: Record<AuditKind, number> = {
    "alert.evicted": 0,
    "silence.evicted": 0,
    "stream.dropped": 0,
  };

  constructor(private readonly limit = AUDIT_RING_LIMIT) {}

  record(input: {
    kind: AuditKind;
    deviceId: string;
    recordedAtMs: number;
    detail: string;
  }): Readonly<AuditEvent> {
    this.recorded += 1;
    this.byKind[input.kind] += 1;
    // Monotonic for the same reason DecisionLog clamps its stamps: a server
    // clock stepping back must not let a later event sort before an earlier
    // one when somebody eventually reads this.
    const recordedAtMs = Math.max(input.recordedAtMs, this.lastRecordedAtMs);
    this.lastRecordedAtMs = recordedAtMs;

    const event: AuditEvent = {
      seq: this.recorded,
      kind: input.kind,
      deviceId: input.deviceId,
      recordedAtMs,
      detail: input.detail,
    };
    // Frozen, so "nothing written is changed" is a property of the object
    // rather than a promise about its callers.
    Object.freeze(event);

    this.ring.push(event);
    if (this.ring.length > this.limit) {
      this.evicted += this.ring.length - this.limit;
      this.ring.splice(0, this.ring.length - this.limit);
    }
    return event;
  }

  /** The tail the ring still holds, oldest first. A copy, not the ring. */
  list(): readonly AuditEvent[] {
    return [...this.ring];
  }

  /** The half eviction cannot reach. */
  totals(): AuditTotals {
    return {
      recorded: this.recorded,
      evicted: this.evicted,
      retained: this.ring.length,
      byKind: { ...this.byKind },
    };
  }
}
