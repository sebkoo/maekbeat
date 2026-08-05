import type { VitalsFrame } from "@maekbeat/protocol";

/**
 * Reorder tolerance in frames. A seq within [highSeq - WINDOW, highSeq] is a
 * late arrival or retransmit and dedupes inside the current session; a seq
 * below that window is a device reboot (or equivalent reset) and starts a new
 * session epoch. Decision record: docs/DECISIONS.md #11; residual limits are
 * documented in packages/protocol/README.md.
 */
export const SEQ_REORDER_WINDOW = 64;

/** A frame at rest: the wire frame plus the two server-side ingest stamps. */
export interface StoredVitalsFrame extends VitalsFrame {
  /** Server clock at ingest — the drift signal (docs/ARCHITECTURE.md). */
  receivedAtMs: number;
  /** Server-side session counter; bumps when seq regresses past the window. */
  sessionEpoch: number;
}

export type IngestResult =
  | { kind: "accepted"; sessionEpoch: number; newSession: boolean }
  | { kind: "duplicate"; sessionEpoch: number };

export interface DeviceSummary {
  deviceId: string;
  sessionEpoch: number;
  frameCount: number;
  lastSeq: number;
  lastReceivedAtMs: number;
  duplicatesDropped: number;
}

interface DeviceState {
  /** Ring in arrival order — reads sort by (capturedAtMs, seq) at query time. */
  frames: StoredVitalsFrame[];
  epoch: number;
  /** Highest seq accepted in the current epoch. */
  highSeq: number;
  /** Accepted seqs within the reorder window of highSeq — the dedupe set. */
  seenSeqs: Set<number>;
  duplicatesDropped: number;
  lastReceivedAtMs: number;
}

export interface StoreStats {
  accepted: number;
  duplicatesDropped: number;
  sessionsStarted: number;
}

/**
 * In-process per-device ring buffer — the dev form of the event queue
 * (docs/ARCHITECTURE.md stage 4; SQS is the target form). Bounded: each device
 * keeps at most `capacity` frames, evicting the oldest arrival first. Identity
 * is (deviceId, sessionEpoch, seq) — never a timestamp.
 */
export class VitalsStore {
  private readonly devices = new Map<string, DeviceState>();
  readonly stats: StoreStats = { accepted: 0, duplicatesDropped: 0, sessionsStarted: 0 };

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
  }

  ingest(frame: VitalsFrame, receivedAtMs: number): IngestResult {
    let device = this.devices.get(frame.deviceId);
    let newSession = false;

    if (!device) {
      device = {
        frames: [],
        epoch: 1,
        highSeq: frame.seq,
        seenSeqs: new Set(),
        duplicatesDropped: 0,
        lastReceivedAtMs: receivedAtMs,
      };
      this.devices.set(frame.deviceId, device);
      newSession = true;
    } else if (frame.seq < device.highSeq - SEQ_REORDER_WINDOW) {
      // Regression past the reorder window: reboot semantics — new session.
      device.epoch += 1;
      device.highSeq = frame.seq;
      device.seenSeqs.clear();
      newSession = true;
    } else if (device.seenSeqs.has(frame.seq)) {
      device.duplicatesDropped += 1;
      device.lastReceivedAtMs = receivedAtMs;
      this.stats.duplicatesDropped += 1;
      return { kind: "duplicate", sessionEpoch: device.epoch };
    }

    if (newSession) {
      this.stats.sessionsStarted += 1;
    }

    device.seenSeqs.add(frame.seq);
    if (frame.seq > device.highSeq) {
      device.highSeq = frame.seq;
      for (const seq of device.seenSeqs) {
        if (seq < device.highSeq - SEQ_REORDER_WINDOW) {
          device.seenSeqs.delete(seq);
        }
      }
    }

    device.frames.push({ ...frame, receivedAtMs, sessionEpoch: device.epoch });
    if (device.frames.length > this.capacity) {
      device.frames.shift();
    }
    device.lastReceivedAtMs = receivedAtMs;
    this.stats.accepted += 1;
    return { kind: "accepted", sessionEpoch: device.epoch, newSession };
  }

  listDevices(): DeviceSummary[] {
    return [...this.devices.entries()].map(([deviceId, device]) => ({
      deviceId,
      sessionEpoch: device.epoch,
      frameCount: device.frames.length,
      lastSeq: device.highSeq,
      lastReceivedAtMs: device.lastReceivedAtMs,
      duplicatesDropped: device.duplicatesDropped,
    }));
  }

  /**
   * Frames for one device ordered by (capturedAtMs, seq) — arrival order never
   * leaks into read order, per docs/ARCHITECTURE.md. `sinceMs` is an inclusive
   * lower bound on capturedAtMs. Returns undefined for an unknown device.
   */
  readFrames(
    deviceId: string,
    options: { sinceMs?: number; limit: number },
  ): StoredVitalsFrame[] | undefined {
    const device = this.devices.get(deviceId);
    if (!device) {
      return undefined;
    }
    const { sinceMs, limit } = options;
    const ordered = [...device.frames].sort(
      (a, b) => a.capturedAtMs - b.capturedAtMs || a.seq - b.seq,
    );
    const filtered =
      sinceMs === undefined ? ordered : ordered.filter((f) => f.capturedAtMs >= sinceMs);
    return filtered.slice(0, limit);
  }
}
