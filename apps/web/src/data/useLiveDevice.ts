import {
  latestDecisions,
  type AlertDecision,
  type AlertDecisionEvent,
  type AlertEvent,
  type DeviceSilenceEvent,
} from "@maekbeat/protocol";
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
  /** Episodes of the device sending nothing at all (C20a). */
  silence: DeviceSilenceEvent[];
  /** The device's append-only decision log, oldest first (C12). */
  decisions: AlertDecisionEvent[];
  /**
   * Process-lifetime counters from apps/server, as of the last REST read —
   * mount or reconnect back-fill. `suppressed` episodes never produce an alert
   * record, so this is the only place that number can come from.
   */
  counters: {
    raised: number;
    resolved: number;
    suppressed: number;
    acknowledged: number;
    dismissed: number;
  };
}

export interface LiveDevice {
  /** The initial REST read; the chart renders once this is ready. */
  state: AsyncState<LiveWindow>;
  reload: () => void;
  connection: ConnectionState;
  /** Messages the protocol contract rejected: dropped, counted, never drawn. */
  malformed: number;
  /** Decision in force per alertId, derived from the log — never stored. */
  decisions: ReadonlyMap<string, AlertDecisionEvent>;
  /** Alert ids with a decision in flight. */
  pendingDecisions: ReadonlySet<string>;
  /** Alert ids whose last decision failed, with the reason. */
  decisionFailures: ReadonlyMap<string, string>;
  /** Records a decision; resolves once the server has appended it. */
  decide: (alertId: string, decision: AlertDecision) => Promise<void>;
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

/** The append counter the server embeds in an eventId (`<device>:decision:<n>`). */
function appendOrdinal(eventId: string): number {
  const ordinal = Number(eventId.slice(eventId.lastIndexOf(":") + 1));
  return Number.isFinite(ordinal) ? ordinal : 0;
}

/** The log is append-only, so merging is union-by-eventId, never replacement. */
export function mergeDecisions(
  current: readonly AlertDecisionEvent[],
  incoming: readonly AlertDecisionEvent[],
) {
  if (incoming.length === 0) return current as AlertDecisionEvent[];
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  // Ties break on the server's append ordinal, which eventId carries: two
  // decisions inside one millisecond must not be ordered by which socket
  // message happened to arrive first.
  return [...byId.values()].sort(
    (a, b) =>
      a.recordedAtMs - b.recordedAtMs || appendOrdinal(a.eventId) - appendOrdinal(b.eventId),
  );
}

/** An alert keeps its identity across states, so a transition replaces it. */
export function mergeAlerts(current: readonly AlertEvent[], incoming: readonly AlertEvent[]) {
  if (incoming.length === 0) return current as AlertEvent[];
  const byId = new Map(current.map((alert) => [alert.alertId, alert]));
  for (const alert of incoming) byId.set(alert.alertId, alert);
  return [...byId.values()].sort((a, b) => a.raisedAtMs - b.raisedAtMs);
}

/**
 * The same rule for silence episodes, and it has to be: the server publishes a
 * raise and then a resolve under one alertId, so an append would leave the
 * dashboard showing a device as still quiet after it came back.
 */
export function mergeSilence(
  current: readonly DeviceSilenceEvent[],
  incoming: readonly DeviceSilenceEvent[],
) {
  if (incoming.length === 0) return current as DeviceSilenceEvent[];
  const byId = new Map(current.map((episode) => [episode.alertId, episode]));
  for (const episode of incoming) byId.set(episode.alertId, episode);
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
      return {
        frames: frames.frames,
        alerts: alerts.alerts,
        silence: alerts.silence,
        decisions: alerts.decisions,
        counters: alerts.counters,
      };
    },
    [api, deviceId],
  );

  const { state, reload } = useAsync(read, [api, deviceId]);

  // Frames and alerts that arrive before the mount read has seeded the window.
  // They are held rather than dropped: at 1 Hz a dropped push is a one- or
  // two-second hole, small enough to fall under the gap threshold and be drawn
  // as continuous — silence rendered as coverage, the thing this file exists to
  // prevent. Merging is keyed, so overlap with the REST snapshot costs nothing.
  const pending = useRef<{
    frames: StoredFrame[];
    alerts: AlertEvent[];
    silence: DeviceSilenceEvent[];
    decisions: AlertDecisionEvent[];
  }>({ frames: [], alerts: [], silence: [], decisions: [] });

  /** The current subscription's signal, read by decide() to detect staleness. */
  const subscriptionScope = useRef<AbortSignal>(new AbortController().signal);

  // The socket is opened once per device and closed on unmount or device
  // change; nothing else in the app opens one.
  useEffect(() => {
    setLive(null);
    setMalformed(0);
    setPendingDecisions(new Set());
    setDecisionFailures(new Map());
    pending.current = { frames: [], alerts: [], silence: [], decisions: [] };
    // Scopes the back-fill to this subscription: a read still in flight when
    // the device changes must never merge one device's frames into another's
    // window.
    const controller = new AbortController();
    subscriptionScope.current = controller.signal;

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
      onSilence: (episode) =>
        setLive((current) => {
          if (current === null) {
            pending.current.silence.push(episode);
            return current;
          }
          return { ...current, silence: mergeSilence(current.silence, [episode]) };
        }),
      onDecision: (event) => {
        clearFailure(event.alertId);
        setLive((current) => {
          if (current === null) {
            pending.current.decisions.push(event);
            return current;
          }
          return { ...current, decisions: mergeDecisions(current.decisions, [event]) };
        });
      },
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
                    silence: mergeSilence(current.silence, alerts.silence),
                    decisions: mergeDecisions(current.decisions, alerts.decisions),
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
        pending.current = { frames: [], alerts: [], silence: [], decisions: [] };
        return {
          frames: mergeFrames(seed.frames, held.frames),
          alerts: mergeAlerts(seed.alerts, held.alerts),
          silence: mergeSilence(seed.silence, held.silence),
          decisions: mergeDecisions(seed.decisions, held.decisions),
          counters: seed.counters,
        };
      }
      return {
        frames: mergeFrames(current.frames, seed.frames),
        alerts: mergeAlerts(current.alerts, seed.alerts),
        silence: mergeSilence(current.silence, seed.silence),
        decisions: mergeDecisions(current.decisions, seed.decisions),
        counters: seed.counters,
      };
    });
  }, [state]);

  const [pendingDecisions, setPendingDecisions] = useState<ReadonlySet<string>>(new Set());
  const [decisionFailures, setDecisionFailures] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * A recorded decision retires any failure banner for that alert, whatever
   * path the decision arrived by — this dashboard's own POST, another
   * dashboard's over the socket, or a REST re-read. Otherwise the row would
   * show the decision and "not recorded" at the same time, and the second
   * claim would be a lie about the audit log that nothing could ever clear.
   */
  const clearFailure = useCallback((alertId: string) => {
    setDecisionFailures((current) => {
      if (!current.has(alertId)) return current;
      const next = new Map(current);
      next.delete(alertId);
      return next;
    });
  }, []);

  /**
   * Records a decision. The row goes busy immediately, but no decision is shown
   * until the server has appended one: an optimistic checkmark that a failed
   * request leaves behind would be the UI asserting an audit-log entry that
   * does not exist. On failure the row says so and offers the buttons again.
   */
  const decide = useCallback(
    async (alertId: string, decision: AlertDecision) => {
      // Scoped like every other async path here: a POST still in flight when
      // the route moves to another device must not merge this device's
      // decision — or its failure — into that one's window.
      const scope = subscriptionScope.current;
      setPendingDecisions((current) => new Set(current).add(alertId));
      clearFailure(alertId);
      try {
        const event = await api.recordDecision(deviceId, alertId, decision);
        if (scope.aborted) return;
        setLive((current) =>
          current === null
            ? current
            : { ...current, decisions: mergeDecisions(current.decisions, [event]) },
        );
      } catch (cause) {
        if (scope.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setDecisionFailures((current) => new Map(current).set(alertId, message));
      } finally {
        if (!scope.aborted) {
          setPendingDecisions((current) => {
            const next = new Set(current);
            next.delete(alertId);
            return next;
          });
        }
      }
    },
    [api, deviceId, clearFailure],
  );

  const merged: AsyncState<LiveWindow> =
    state.status === "ready" && live !== null ? { status: "ready", data: live } : state;

  return {
    state: merged,
    reload,
    connection,
    malformed,
    // Derived on every render from the log: the decision in force is a reading
    // of the events, never a field anyone writes.
    decisions: latestDecisions(live?.decisions ?? []),
    pendingDecisions,
    decisionFailures,
    decide,
  };
}
