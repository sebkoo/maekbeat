import type { VitalsFrame } from "@maekbeat/protocol";
import { describe, expect, it } from "vitest";

import { SEQ_REORDER_WINDOW, VitalsStore } from "./store";

function frame(overrides: Partial<VitalsFrame> = {}): VitalsFrame {
  return {
    v: 1,
    deviceId: "dev-a",
    seq: 0,
    capturedAtMs: 1_000,
    heartRateBpm: 62,
    spo2Pct: 97.5,
    respirationRpm: 14,
    motion: 0.01,
    ...overrides,
  };
}

describe("VitalsStore ingest", () => {
  it("accepts monotonic frames and stores receivedAtMs and sessionEpoch", () => {
    const store = new VitalsStore(10);
    const first = store.ingest(frame({ seq: 0 }), 5_000);
    const second = store.ingest(frame({ seq: 1, capturedAtMs: 2_000 }), 5_001);

    expect(first).toEqual({
      kind: "accepted",
      sessionEpoch: 1,
      newSession: true,
      outOfOrder: false,
    });
    expect(second).toEqual({
      kind: "accepted",
      sessionEpoch: 1,
      newSession: false,
      outOfOrder: false,
    });

    const frames = store.readFrames("dev-a", { limit: 10 });
    expect(frames).toHaveLength(2);
    expect(frames?.[0]).toMatchObject({ seq: 0, receivedAtMs: 5_000, sessionEpoch: 1 });
    expect(frames?.[1]).toMatchObject({ seq: 1, receivedAtMs: 5_001, sessionEpoch: 1 });
  });

  it("drops a duplicate seq within the session and counts it", () => {
    const store = new VitalsStore(10);
    store.ingest(frame({ seq: 3 }), 5_000);
    const result = store.ingest(frame({ seq: 3 }), 5_001);

    // A retransmit of the newest seq: a duplicate, but not a late arrival.
    expect(result).toEqual({ kind: "duplicate", sessionEpoch: 1, outOfOrder: false });
    expect(store.readFrames("dev-a", { limit: 10 })).toHaveLength(1);
    expect(store.stats.duplicatesDropped).toBe(1);
    expect(store.listDevices()[0]?.duplicatesDropped).toBe(1);
  });

  it("accepts a late arrival inside the reorder window exactly once", () => {
    const store = new VitalsStore(10);
    store.ingest(frame({ seq: 10, capturedAtMs: 10_000 }), 5_000);
    const late = store.ingest(frame({ seq: 8, capturedAtMs: 8_000 }), 5_001);
    const retransmit = store.ingest(frame({ seq: 8, capturedAtMs: 8_000 }), 5_002);

    expect(late).toEqual({
      kind: "accepted",
      sessionEpoch: 1,
      newSession: false,
      outOfOrder: true,
    });
    expect(retransmit).toEqual({ kind: "duplicate", sessionEpoch: 1, outOfOrder: true });
    expect(store.readFrames("dev-a", { limit: 10 })).toHaveLength(2);
  });

  it("starts a new session when seq regresses past the reorder window", () => {
    const store = new VitalsStore(300);
    const high = SEQ_REORDER_WINDOW + 100;
    store.ingest(frame({ seq: high, capturedAtMs: 100_000 }), 5_000);
    const reboot = store.ingest(frame({ seq: 0, capturedAtMs: 200_000 }), 6_000);

    // A reboot is a new session, not a late frame — the two are reported apart.
    expect(reboot).toEqual({
      kind: "accepted",
      sessionEpoch: 2,
      newSession: true,
      outOfOrder: false,
    });
    expect(store.stats.sessionsStarted).toBe(2);
    // The old session's frames stay in the buffer as history.
    expect(store.readFrames("dev-a", { limit: 10 })).toHaveLength(2);
    // seq 0 in the new epoch is not a duplicate of anything from epoch 1.
    const next = store.ingest(frame({ seq: 1, capturedAtMs: 200_001 }), 6_001);
    expect(next).toEqual({
      kind: "accepted",
      sessionEpoch: 2,
      newSession: false,
      outOfOrder: false,
    });
  });

  it("treats a regression at the window edge as in-session, one past it as a reboot", () => {
    const store = new VitalsStore(300);
    const high = 200;
    store.ingest(frame({ seq: high, capturedAtMs: 100_000 }), 5_000);

    const edge = store.ingest(
      frame({ seq: high - SEQ_REORDER_WINDOW, capturedAtMs: 90_000 }),
      5_001,
    );
    expect(edge).toEqual({
      kind: "accepted",
      sessionEpoch: 1,
      newSession: false,
      outOfOrder: true,
    });

    const past = store.ingest(
      frame({ seq: high - SEQ_REORDER_WINDOW - 1, capturedAtMs: 90_000 }),
      5_002,
    );
    expect(past).toEqual({
      kind: "accepted",
      sessionEpoch: 2,
      newSession: true,
      outOfOrder: false,
    });
  });

  it("dedupes retransmits of frames already evicted from the ring", () => {
    const store = new VitalsStore(2);
    store.ingest(frame({ seq: 10, capturedAtMs: 1_000 }), 5_000);
    store.ingest(frame({ seq: 11, capturedAtMs: 2_000 }), 5_001);
    store.ingest(frame({ seq: 12, capturedAtMs: 3_000 }), 5_002);
    // seq 10 is evicted (capacity 2) but still within the seq window: duplicate.
    const retransmit = store.ingest(frame({ seq: 10, capturedAtMs: 1_000 }), 5_003);
    expect(retransmit).toEqual({ kind: "duplicate", sessionEpoch: 1, outOfOrder: true });
  });

  it("evicts the oldest arrival at capacity", () => {
    const store = new VitalsStore(5);
    for (let seq = 0; seq < 8; seq++) {
      store.ingest(frame({ seq, capturedAtMs: 1_000 + seq }), 5_000 + seq);
    }
    const frames = store.readFrames("dev-a", { limit: 10 });
    expect(frames?.map((f) => f.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(store.listDevices()[0]?.frameCount).toBe(5);
  });
});

describe("VitalsStore reads", () => {
  it("orders by (capturedAtMs, seq) regardless of arrival order", () => {
    const store = new VitalsStore(10);
    store.ingest(frame({ seq: 2, capturedAtMs: 3_000 }), 5_000);
    store.ingest(frame({ seq: 0, capturedAtMs: 1_000 }), 5_001);
    // Equal capture time: seq breaks the tie.
    store.ingest(frame({ seq: 3, capturedAtMs: 1_000 }), 5_002);

    const frames = store.readFrames("dev-a", { limit: 10 });
    expect(frames?.map((f) => [f.capturedAtMs, f.seq])).toEqual([
      [1_000, 0],
      [1_000, 3],
      [3_000, 2],
    ]);
  });

  it("applies sinceMs inclusively and limit after ordering", () => {
    const store = new VitalsStore(10);
    for (let seq = 0; seq < 5; seq++) {
      store.ingest(frame({ seq, capturedAtMs: 1_000 * (seq + 1) }), 5_000 + seq);
    }
    const since = store.readFrames("dev-a", { sinceMs: 3_000, limit: 10 });
    expect(since?.map((f) => f.capturedAtMs)).toEqual([3_000, 4_000, 5_000]);

    const limited = store.readFrames("dev-a", { sinceMs: 3_000, limit: 2 });
    expect(limited?.map((f) => f.capturedAtMs)).toEqual([3_000, 4_000]);
  });

  it("returns undefined for an unknown device", () => {
    const store = new VitalsStore(10);
    expect(store.readFrames("nobody", { limit: 10 })).toBeUndefined();
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new VitalsStore(0)).toThrowError(/capacity/);
  });
});
