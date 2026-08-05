import type { AlertDecisionEvent, AlertEvent } from "@maekbeat/protocol";

import { AlertStateBadge } from "./AlertStateBadge";
import { formatInstant } from "../format";

/*
 * Episodes, not firings. The C7 engine already guarantees one alertId per
 * breach episode — raised, then ongoing, then resolved — so a 30-tick anomaly
 * is one row with a duration rather than thirty. Alarm fatigue is the design
 * constraint the C21 risk register will cite, and a timeline that counts
 * firings would manufacture exactly the noise the engine exists to avoid.
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

export interface AlertTimelineProps {
  alerts: readonly AlertEvent[];
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
  if (props.alerts.length === 0) {
    return <p className="mb-meta">No alerts recorded for this device.</p>;
  }

  // Newest episode first: a caregiver reads the top of this list.
  const episodes = [...props.alerts].sort((a, b) => b.raisedAtMs - a.raisedAtMs);

  return (
    <ol className="mb-timeline">
      {episodes.map((alert) => {
        const decision = props.decisions.get(alert.alertId);
        const failure = props.failures.get(alert.alertId);
        const busy = props.pending.has(alert.alertId);
        const duration = formatDuration(episodeDurationMs(alert, props.nowMs));
        const label = `${alert.metric} ${alert.direction}`;

        return (
          <li className="mb-timeline__row" key={alert.alertId} data-alert-state={alert.state}>
            <div className="mb-timeline__head">
              <AlertStateBadge state={alert.state} />
              <span className="mb-timeline__metric">{label}</span>
              <span className="mb-timeline__duration">
                {alert.resolvedAtMs === undefined ? `${duration} and counting` : duration}
              </span>
            </div>

            <p className="mb-timeline__times">
              raised {formatInstant(alert.raisedAtMs)}
              {alert.resolvedAtMs === undefined
                ? ""
                : ` · resolved ${formatInstant(alert.resolvedAtMs)}`}{" "}
              · window min {alert.windowStats.minValue} · max {alert.windowStats.maxValue}
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
                  onClick={() => props.onDecide(alert.alertId, "acknowledged")}
                >
                  Acknowledge
                </button>
                <button
                  type="button"
                  className="mb-button mb-button--quiet"
                  aria-label={`Dismiss ${label} alert as not actionable`}
                  disabled={busy}
                  onClick={() => props.onDecide(alert.alertId, "dismissed")}
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
    </ol>
  );
}
