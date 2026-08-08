import type { AlertDecisionEvent, AlertEvent, DeviceSilenceEvent } from "@maekbeat/protocol";

import { AlertStateBadge } from "./AlertStateBadge";
import { formatInstant } from "../format";

/*
 * Episodes, not firings. The C7 engine already guarantees one alertId per
 * breach episode — raised, then ongoing, then resolved — so a 30-tick anomaly
 * is one row with a duration rather than thirty. Alarm fatigue is the design
 * constraint the C21 risk register will cite, and a timeline that counts
 * firings would manufacture exactly the noise the engine exists to avoid.
 *
 * Since C20a the list holds two kinds of episode. A threshold alert is a claim
 * about a value; a silence episode is a claim about the absence of frames, and
 * the chart's own rule — C11's, that a gap is drawn as a gap and never
 * interpolated across — has never been able to say that a gap MATTERS. This
 * row is where it says so.
 *
 * They share this list rather than getting a treatment of their own, and that
 * is a decision. The three states are the same three, so docs/DECISIONS.md #12
 * already assigns them a word, a mark and a border; what differs is the
 * subject, and the subject is what the label is for. A second visual language
 * for a second kind of episode would be one more thing a caregiver has to
 * learn at the moment they have the least attention to spare.
 */

/** Milliseconds an episode has lasted, or lasted for before it resolved. */
export function episodeDurationMs(alert: AlertEvent, nowMs: number): number {
  return Math.max(0, (alert.resolvedAtMs ?? nowMs) - alert.raisedAtMs);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** One row's worth of episode, whichever kind produced it. */
interface Episode {
  kind: "threshold" | "silence";
  alertId: string;
  state: AlertEvent["state"];
  raisedAtMs: number;
  resolvedAtMs: number | undefined;
  /** The subject, used verbatim in the row and inside both button names. */
  label: string;
  durationMs: number;
  /** The line under the head: what this episode is evidence of. */
  detail: string;
}

/**
 * A silence episode measures its own duration and does not take `nowMs`.
 *
 * `nowMs` on this page is the newest frame's receive stamp, which for a device
 * that has stopped sending is the moment the silence STARTED — so borrowing it
 * would render every open silence episode as zero seconds long, the reassuring
 * answer and the wrong one. The server already counts the gap on the record.
 */
function fromSilence(episode: DeviceSilenceEvent): Episode {
  return {
    kind: "silence",
    alertId: episode.alertId,
    state: episode.state,
    raisedAtMs: episode.raisedAtMs,
    resolvedAtMs: episode.resolvedAtMs,
    label: "no data from device",
    durationMs: episode.silentForMs,
    detail:
      `last frame ${formatInstant(episode.lastFrameAtMs)} · session ${episode.sessionEpoch}` +
      ` · threshold ${formatDuration(episode.thresholdMs)}`,
  };
}

function fromAlert(alert: AlertEvent, nowMs: number): Episode {
  return {
    kind: "threshold",
    alertId: alert.alertId,
    state: alert.state,
    raisedAtMs: alert.raisedAtMs,
    resolvedAtMs: alert.resolvedAtMs,
    label: `${alert.metric} ${alert.direction}`,
    durationMs: episodeDurationMs(alert, nowMs),
    detail: `window min ${alert.windowStats.minValue} · max ${alert.windowStats.maxValue}`,
  };
}

export interface AlertTimelineProps {
  alerts: readonly AlertEvent[];
  /** Episodes of the device sending nothing at all (C20a). */
  silence: readonly DeviceSilenceEvent[];
  /** Decision in force per alertId, derived from the append-only log. */
  decisions: ReadonlyMap<string, AlertDecisionEvent>;
  /** Alert ids with a decision in flight; their controls are disabled. */
  pending: ReadonlySet<string>;
  /** Alert ids whose last decision failed, with the reason to show. */
  failures: ReadonlyMap<string, string>;
  nowMs: number;
  onDecide: (alertId: string, decision: "acknowledged" | "dismissed") => void;
}

export function AlertTimeline(props: AlertTimelineProps) {
  // Both kinds into one list, newest first: a caregiver reads the top of it,
  // and what they need at the top is whatever happened last — not whichever
  // list it happened to come out of.
  const episodes = [
    ...props.alerts.map((alert) => fromAlert(alert, props.nowMs)),
    ...props.silence.map(fromSilence),
  ].sort((a, b) => b.raisedAtMs - a.raisedAtMs);

  // A decision can outlive the alert it judged: both the server's decision log
  // and its alert history are bounded, and the log's bound is the larger of the
  // two (200 per device against 100, docs/DECISIONS.md #15). Neither is
  // permanent. Those decisions are shown as their own rows rather than dropped —
  // hiding a judgement because its subject was evicted would lose the only
  // record that anyone triaged the event at all. Silence episodes are bounded
  // too (C20a), so `retained` reads both lists or an acknowledged silent
  // device would produce a phantom orphan row the moment it was evicted.
  const retained = new Set(episodes.map((episode) => episode.alertId));
  const orphaned = [...props.decisions.values()]
    .filter((decision) => !retained.has(decision.alertId))
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs);

  if (episodes.length === 0 && orphaned.length === 0) {
    return <p className="mb-meta">No alerts recorded for this device.</p>;
  }

  return (
    <ol className="mb-timeline">
      {episodes.map((episode) => {
        const decision = props.decisions.get(episode.alertId);
        const failure = props.failures.get(episode.alertId);
        const busy = props.pending.has(episode.alertId);
        const duration = formatDuration(episode.durationMs);
        const label = episode.label;

        return (
          <li
            className="mb-timeline__row"
            key={episode.alertId}
            data-alert-state={episode.state}
            data-alert-kind={episode.kind}
          >
            <div className="mb-timeline__head">
              <AlertStateBadge state={episode.state} />
              <span className="mb-timeline__metric">{label}</span>
              <span className="mb-timeline__duration">
                {episode.resolvedAtMs === undefined ? `${duration} and counting` : duration}
              </span>
            </div>

            <p className="mb-timeline__times">
              raised {formatInstant(episode.raisedAtMs)}
              {episode.resolvedAtMs === undefined
                ? ""
                : ` · resolved ${formatInstant(episode.resolvedAtMs)}`}{" "}
              · {episode.detail}
            </p>

            {decision === undefined ? (
              <div className="mb-timeline__actions">
                {/* The accessible name starts with the visible word, so
                    WCAG 2.2 SC 2.5.3 (label in name) holds and a voice user
                    can say "Acknowledge" — while a screen-reader user hears
                    which of several episodes the button belongs to. */}
                <button
                  type="button"
                  className="mb-button"
                  aria-label={`Acknowledge ${label} alert`}
                  disabled={busy}
                  onClick={() => props.onDecide(episode.alertId, "acknowledged")}
                >
                  Acknowledge
                </button>
                <button
                  type="button"
                  className="mb-button mb-button--quiet"
                  aria-label={`Dismiss ${label} alert as not actionable`}
                  disabled={busy}
                  onClick={() => props.onDecide(episode.alertId, "dismissed")}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <p className="mb-timeline__decision" data-decision={decision.decision}>
                {decision.decision === "acknowledged" ? "Acknowledged" : "Dismissed"} by{" "}
                {decision.actor} at {formatInstant(decision.recordedAtMs)}
              </p>
            )}

            {/* Belt and braces with the hook's clearing: a landed decision
                and a "not recorded" line must never share a row. */}
            {failure === undefined || decision !== undefined ? null : (
              <p className="mb-timeline__failure" role="alert">
                Not recorded: {failure}
              </p>
            )}
          </li>
        );
      })}

      {orphaned.map((decision) => (
        <li className="mb-timeline__row mb-timeline__row--orphaned" key={decision.eventId}>
          <div className="mb-timeline__head">
            <span className="mb-timeline__metric">Decided, alert no longer retained</span>
            <span className="mb-timeline__duration">{decision.alertId}</span>
          </div>
          <p className="mb-timeline__decision" data-decision={decision.decision}>
            {decision.decision === "acknowledged" ? "Acknowledged" : "Dismissed"} by{" "}
            {decision.actor} at {formatInstant(decision.recordedAtMs)}
          </p>
          <p className="mb-timeline__times">
            The alert record left the server&rsquo;s bounded history; the decision log kept this.
          </p>
        </li>
      ))}
    </ol>
  );
}
