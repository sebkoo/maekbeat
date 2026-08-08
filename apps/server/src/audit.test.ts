import { describe, expect, it } from "vitest";

import { AUDIT_RING_LIMIT, AuditLog } from "./audit";

describe("AuditLog", () => {
  it("records a state change and hands back what it wrote", () => {
    const log = new AuditLog();

    const event = log.record({
      kind: "alert.evicted",
      deviceId: "dev-1",
      recordedAtMs: 1_000,
      detail: "history full of undecided alerts",
    });

    expect(event).toEqual({
      seq: 1,
      kind: "alert.evicted",
      deviceId: "dev-1",
      recordedAtMs: 1_000,
      detail: "history full of undecided alerts",
    });
    expect(log.list()).toEqual([event]);
    expect(log.totals()).toEqual({
      recorded: 1,
      evicted: 0,
      retained: 1,
      byKind: { "alert.evicted": 1, "silence.evicted": 0, "stream.dropped": 0 },
    });
  });

  // The composition, in one run. Testing the ring's bound and the counters
  // separately would prove each half and not that they hold together, which is
  // the failure this repository keeps finding: the unit is correct and nothing
  // exercises the seam. So this floods past the bound and asserts BOTH — that
  // entries were evicted, and that the counters kept counting through it.
  it("loses entries past the bound and keeps counting through the loss", () => {
    const limit = 4;
    const log = new AuditLog(limit);
    const flood = 10;

    for (let i = 1; i <= flood; i++) {
      log.record({
        kind: "alert.evicted",
        deviceId: "dev-1",
        recordedAtMs: i,
        detail: `drop ${i}`,
      });
    }

    // Half one: the ring lost the early events. This is the blind spot.
    const kept = log.list();
    expect(kept).toHaveLength(limit);
    expect(kept.map((event) => event.seq)).toEqual([7, 8, 9, 10]);

    // Half two: the record of the flood survived the flood.
    expect(log.totals()).toEqual({
      recorded: flood,
      evicted: flood - limit,
      retained: limit,
      byKind: {
        "alert.evicted": flood,
        "silence.evicted": 0,
        "stream.dropped": 0,
      },
    });

    // The point stated as an assertion rather than as a comment: what the ring
    // can still show is a fraction of what happened, and the counter is not.
    expect(kept.length).toBeLessThan(log.totals().recorded);
  });

  it("counts each kind apart so one flood does not hide another", () => {
    const log = new AuditLog(2);

    log.record({ kind: "alert.evicted", deviceId: "a", recordedAtMs: 1, detail: "x" });
    log.record({ kind: "stream.dropped", deviceId: "b", recordedAtMs: 2, detail: "y" });
    log.record({ kind: "silence.evicted", deviceId: "c", recordedAtMs: 3, detail: "z" });

    // The ring holds two; every kind is still counted once.
    expect(log.list()).toHaveLength(2);
    expect(log.totals().byKind).toEqual({
      "alert.evicted": 1,
      "silence.evicted": 1,
      "stream.dropped": 1,
    });
  });

  it("cannot be edited through what it hands out", () => {
    const log = new AuditLog();
    const event = log.record({
      kind: "stream.dropped",
      deviceId: "dev-1",
      recordedAtMs: 5,
      detail: "buffer limit exceeded",
    });

    expect(() => {
      (event as { detail: string }).detail = "rewritten";
    }).toThrow();

    const handed = log.list() as AuditEvent[];
    handed.push({ ...event, seq: 99 });
    expect(log.list()).toHaveLength(1);

    const totals = log.totals() as { recorded: number };
    totals.recorded = 0;
    expect(log.totals().recorded).toBe(1);
  });

  it("keeps recorded timestamps monotonic across a clock step back", () => {
    const log = new AuditLog();

    log.record({ kind: "alert.evicted", deviceId: "d", recordedAtMs: 5_000, detail: "first" });
    const second = log.record({
      kind: "alert.evicted",
      deviceId: "d",
      recordedAtMs: 1_000,
      detail: "clock stepped back",
    });

    expect(second.recordedAtMs).toBe(5_000);
  });

  it("defaults to the documented ring limit", () => {
    const log = new AuditLog();
    for (let i = 0; i <= AUDIT_RING_LIMIT; i++) {
      log.record({ kind: "alert.evicted", deviceId: "d", recordedAtMs: i, detail: `${i}` });
    }
    expect(log.totals().retained).toBe(AUDIT_RING_LIMIT);
    expect(log.totals().evicted).toBe(1);
  });
});

type AuditEvent = ReturnType<AuditLog["record"]>;
