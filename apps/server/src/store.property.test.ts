import type { VitalsFrame } from "@maekbeat/protocol";
import { mulberry32 } from "@maekbeat/vitals-sim";
import { describe, expect, it } from "vitest";

import { SEQ_REORDER_WINDOW, VitalsStore } from "./store";

// Promoted from the C6 review's ad-hoc seq-pattern attacks into permanent
// regression armor. Fixed seeds + fixed iteration counts keep CI byte-for-byte
// deterministic. Budget: 5 seeds x 400 rounds x 2 interleaved devices x 2
// capacity profiles = 8,000 ingests, milliseconds of runtime.
const SEEDS = [1, 2, 3, 7, 42] as const;
const ROUNDS_PER_RUN = 400;
const BASE_MS = 1_000_000;

function frame(deviceId: string, seq: number): VitalsFrame {
  return {
    v: 1,
    deviceId,
    seq,
    capturedAtMs: BASE_MS + seq * 1_000,
    heartRateBpm: 70,
    spo2Pct: 97,
    respirationRpm: 14,
    motion: 0.01,
  };
}

/**
 * Oracle: the docs/DECISIONS.md #11 contract restated independently of the
 * implementation. First frame opens session 1; a seq regression past the
 * reorder window is a reboot (new epoch); a seq already accepted in the
 * current epoch and still inside the window is a duplicate; everything else
 * is accepted in-session.
 */
interface DeviceModel {
  epoch: number;
  high: number;
  accepted: Set<string>;
  acceptedCount: number;
  duplicates: number;
}

function oracle(
  model: DeviceModel | undefined,
  seq: number,
): { kind: "accepted"; epoch: number; newSession: boolean } | { kind: "duplicate"; epoch: number } {
  if (model === undefined) {
    return { kind: "accepted", epoch: 1, newSession: true };
  }
  if (seq < model.high - SEQ_REORDER_WINDOW) {
    return { kind: "accepted", epoch: model.epoch + 1, newSession: true };
  }
  if (model.accepted.has(`${model.epoch}:${seq}`)) {
    return { kind: "duplicate", epoch: model.epoch };
  }
  return { kind: "accepted", epoch: model.epoch, newSession: false };
}

function applyToModel(models: Map<string, DeviceModel>, deviceId: string, seq: number): void {
  const model = models.get(deviceId);
  const expected = oracle(model, seq);
  if (model === undefined) {
    models.set(deviceId, {
      epoch: 1,
      high: seq,
      accepted: new Set([`1:${seq}`]),
      acceptedCount: 1,
      duplicates: 0,
    });
    return;
  }
  if (expected.kind === "duplicate") {
    model.duplicates += 1;
    return;
  }
  if (expected.newSession) {
    model.epoch += 1;
    model.high = seq;
  } else {
    model.high = Math.max(model.high, seq);
  }
  model.accepted.add(`${model.epoch}:${seq}`);
  model.acceptedCount += 1;
}

/**
 * Seq-pattern attack mix: mostly monotonic advance, plus gaps, retransmits of
 * anything previously sent (any epoch), late arrivals straddling the window
 * edge, and hard reboots to near zero.
 */
function nextAttackSeq(rng: () => number, high: number, sent: number[]): number {
  const r = rng();
  if (r < 0.55) return high + 1;
  if (r < 0.65) return high + 2 + Math.floor(rng() * 8);
  if (r < 0.8 && sent.length > 0) {
    const back = Math.floor(rng() * Math.min(sent.length, 80));
    return sent[sent.length - 1 - back] as number;
  }
  if (r < 0.92) return Math.max(0, high - 1 - Math.floor(rng() * (SEQ_REORDER_WINDOW + 10)));
  return Math.floor(rng() * 4);
}

describe.each([{ capacity: 4096 }, { capacity: 32 }])(
  "VitalsStore under seeded seq-pattern attacks (capacity $capacity)",
  ({ capacity }) => {
    it("matches the DECISIONS #11 oracle on every ingest and postcondition", () => {
      for (const seed of SEEDS) {
        const rng = mulberry32(seed);
        const store = new VitalsStore(capacity);
        const models = new Map<string, DeviceModel>();
        const sentByDevice = new Map<string, number[]>([
          ["attack-a", []],
          ["attack-b", []],
        ]);
        let receivedAtMs = 5_000;
        let totalIngests = 0;

        for (let round = 0; round < ROUNDS_PER_RUN; round++) {
          // Two interleaved devices: cross-device bleed in session or dedupe
          // state would break the per-device oracle immediately.
          for (const [deviceId, sent] of sentByDevice) {
            const model = models.get(deviceId);
            const seq = nextAttackSeq(rng, model?.high ?? 0, sent);
            const expected = oracle(model, seq);

            const result = store.ingest(frame(deviceId, seq), receivedAtMs);
            receivedAtMs += 1;
            totalIngests += 1;
            if (expected.kind === "accepted") {
              expect(result).toEqual({
                kind: "accepted",
                sessionEpoch: expected.epoch,
                newSession: expected.newSession,
              });
            } else {
              expect(result).toEqual({ kind: "duplicate", sessionEpoch: expected.epoch });
            }

            applyToModel(models, deviceId, seq);
            sent.push(seq);
          }
        }

        // Postconditions: summaries and reads agree with the oracle's totals.
        expect(store.stats.accepted + store.stats.duplicatesDropped).toBe(totalIngests);
        // Each device's epoch counts its sessions: epoch 1 at first frame,
        // +1 per reboot — their sum is every session the store ever started.
        expect(store.stats.sessionsStarted).toBe(
          [...models.values()].reduce((sum, m) => sum + m.epoch, 0),
        );
        for (const summary of store.listDevices()) {
          const model = models.get(summary.deviceId);
          expect(model).toBeDefined();
          if (model === undefined) continue;
          expect(summary.sessionEpoch).toBe(model.epoch);
          expect(summary.lastSeq).toBe(model.high);
          expect(summary.duplicatesDropped).toBe(model.duplicates);
          expect(summary.frameCount).toBe(Math.min(model.acceptedCount, capacity));

          const frames = store.readFrames(summary.deviceId, { limit: 65_536 });
          expect(frames).toHaveLength(Math.min(model.acceptedCount, capacity));
          for (let i = 1; i < (frames?.length ?? 0); i++) {
            const prev = frames?.[i - 1];
            const cur = frames?.[i];
            if (prev === undefined || cur === undefined) continue;
            // Read-order invariant: (capturedAtMs, seq), whatever the arrival.
            expect(
              prev.capturedAtMs < cur.capturedAtMs ||
                (prev.capturedAtMs === cur.capturedAtMs && prev.seq <= cur.seq),
            ).toBe(true);
          }

          if (capacity >= ROUNDS_PER_RUN * 2) {
            // Nothing evicted at this capacity: every stored frame identity
            // (sessionEpoch, seq) must be unique — the dedupe invariant.
            const keys = frames?.map((f) => `${f.sessionEpoch}:${f.seq}`) ?? [];
            expect(new Set(keys).size).toBe(keys.length);
          }
        }
      }
    });
  },
);
