import type { AlertEvent } from "@maekbeat/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StoredFrame } from "../api/contracts";
import type { ConnectionState } from "../api/stream";
import { useApi } from "./api-context";
import { useAsync, type AsyncState } from "./useAsync";

/**
 * Frames the dashboard keeps. Chosen to match the largest window one REST
 * back-fill can restore (`limit` maxes at 1000 in apps/server/src/reads.ts);
 * the server's own ring holds RING_CAPACITY frames, 1024 by default, and
 * anything evicted there is gone for good and renders as a gap.
 */
export const MAX_FRAMES = 1_000;

/** Frames requested per route mount and per reconnect back-fill. */
export const BACKFILL_LIMIT = 1_000;

export interface LiveWindow {
  frames: StoredFrame[];
  alerts: AlertEvent[];
  /**
   * Process-lifetime counters from apps/server, as of the last REST read —
   * mount or reconnect back-fill. `suppressed` episodes never produce an alert
   * record, so this is the only place that number can come from.
   */
  counters: { raised: number; resolved: number; suppressed: number };
}

export interface LiveDevice {
  /** The initial REST read; the chart renders once this is ready. */
  state: AsyncState<LiveWindow>;
  reload: () => void;
  connection: ConnectionState;
  /** Messages the protocol contract rejected: dropped, counted, never drawn. */
  malformed: number;
}

const frameKey = (frame: StoredFrame) => `${frame.sessionEpoch}:${frame.seq}`;

/**
 * Merge by (sessionEpoch, seq) and order by (sessionEpoch, capturedAtMs, seq).
 * Session leads the sort because a reboot may reset the device clock: ordering
 * by capture time alone would file the new session's frames *before* the old
 * ones, so a full window would evict every live frame as it arrived and the
 * back-fill bound would be read from a pre-reboot timestamp.
 */
export function mergeFrames(current: readonly StoredFrame[], incoming: readonly StoredFrame[]) {
  if (incoming.length === 0) return current as StoredFrame[];
  const byKey = new Map(current.map((frame) => [frameKey(frame), frame]));
  for (const frame of incoming) byKey.set(frameKey(frame), frame);
  const merged = [...byKey.values()].sort(
    (a, b) => a.sessionEpoch - b.sessionEpoch || a.capturedAtMs - b.capturedAtMs || a.seq - b.seq,
  );
  return merged.length > MAX_FRAMES ? merged.slice(merged.length - MAX_FRAMES) : merged;
}

/** An alert keeps its identity across states, so a transition replaces it. */
export function mergeAlerts(current: readonly AlertEvent[], incoming: readonly AlertEvent[]) {
  if (incoming.length === 0) return current as AlertEvent[];
  const byId = new Map(current.map((alert) => [alert.alertId, alert]));
  for (const alert of incoming) byId.set(alert.alertId, alert);
  return [...byId.values()].sort((a, b) => a.raisedAtMs - b.raisedAtMs);
}

/**
 * One device, live: a REST read on mount, then the fan-out socket appended to
 * it. A reconnect never resumes silently — it re-reads the window from REST
 * first, so a hole in coverage stays a hole in the data rather than becoming an
 * invisible join between two live samples.
 */
export function useLiveDevice(deviceId: string): LiveDevice {
  const api = useApi();
  const [live, setLive] = useState<LiveWindow | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [malformed, setMalformed] = useState(0);

  // Read by the reconnect handler, which must not re-subscribe when it changes.
  const newestCapturedAtMs = useRef<number | undefined>(undefined);
  newestCapturedAtMs.current = live?.frames[live.frames.length - 1]?.capturedAtMs;

  const read = useCallback(
    async (signal: AbortSignal) => {
      const [frames, alerts] = await Promise.all([
        api.readFrames(deviceId, { limit: BACKFILL_LIMIT }, signal),
        api.readAlerts(deviceId, signal),
      ]);
      return { frames: frames.frames, alerts: alerts.alerts, counters: alerts.counters };
    },
    [api, deviceId],
  );

  const { state, reload } = useAsync(read, [api, deviceId]);

  // Frames and alerts that arrive before the mount read has seeded the window.
  // They are held rather than dropped: at 1 Hz a dropped push is a one- or
  // two-second hole, small enough to fall under the gap threshold and be drawn
  // as continuous — silence rendered as coverage, the thing this file exists to
  // prevent. Merging is keyed, so overlap with the REST snapshot costs nothing.
  const pending = useRef<{ frames: StoredFrame[]; alerts: AlertEvent[] }>({
    frames: [],
    alerts: [],
  });

  // The socket is opened once per device and closed on unmount or device
  // change; nothing else in the app opens one.
  useEffect(() => {
    setLive(null);
    setMalformed(0);
    pending.current = { frames: [], alerts: [] };
    // Scopes the back-fill to this subscription: a read still in flight when
    // the device changes must never merge one device's frames into another's
    // window.
    const controller = new AbortController();

    const subscription = api.subscribe(deviceId, {
      onFrame: (frame) =>
        setLive((current) => {
          if (current === null) {
            pending.current.frames.push(frame);
            return current;
          }
          return { ...current, frames: mergeFrames(current.frames, [frame]) };
        }),
      onAlert: (alert) =>
        setLive((current) => {
          if (current === null) {
            pending.current.alerts.push(alert);
            return current;
          }
          return { ...current, alerts: mergeAlerts(current.alerts, [alert]) };
        }),
      onState: setConnection,
      onReconnect: () => {
        void (async () => {
          try {
            const since = newestCapturedAtMs.current;
            const [frames, alerts] = await Promise.all([
              api.readFrames(
                deviceId,
                since === undefined ? { limit: BACKFILL_LIMIT } : { since, limit: BACKFILL_LIMIT },
                controller.signal,
              ),
              api.readAlerts(deviceId, controller.signal),
            ]);
            if (controller.signal.aborted) return;
            setLive((current) =>
              current === null
                ? current
                : {
                    frames: mergeFrames(current.frames, frames.frames),
                    alerts: mergeAlerts(current.alerts, alerts.alerts),
                    counters: alerts.counters,
                  },
            );
          } catch {
            // A failed back-fill leaves the hole visible in the chart, which is
            // the honest outcome; the next reconnect tries again.
          }
        })();
      },
      onInvalidMessage: () => setMalformed((count) => count + 1),
    });

    return () => {
      controller.abort();
      subscription.close();
    };
  }, [api, deviceId]);

  // Fold every completed read into the window — the mount read seeds it, and a
  // reload after an empty window must be able to fill it. Dropping later reads
  // would make the "Try again" button run and then show the same emptiness.
  useEffect(() => {
    if (state.status !== "ready") return;
    const seed = state.data;
    setLive((current) => {
      if (current === null) {
        const held = pending.current;
        pending.current = { frames: [], alerts: [] };
        return {
          frames: mergeFrames(seed.frames, held.frames),
          alerts: mergeAlerts(seed.alerts, held.alerts),
          counters: seed.counters,
        };
      }
      return {
        frames: mergeFrames(current.frames, seed.frames),
        alerts: mergeAlerts(current.alerts, seed.alerts),
        counters: seed.counters,
      };
    });
  }, [state]);

  const merged: AsyncState<LiveWindow> =
    state.status === "ready" && live !== null ? { status: "ready", data: live } : state;

  return { state: merged, reload, connection, malformed };
}
