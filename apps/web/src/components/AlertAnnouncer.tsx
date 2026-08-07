import type { AlertDecisionEvent, AlertEvent, DeviceSilenceEvent } from "@maekbeat/protocol";
import { useEffect, useRef, useState } from "react";

import type { ConnectionState } from "../api/stream";

/*
 * The one live region on the page, and it is deliberately narrow.
 *
 * A streaming vitals chart must never be an aria-live firehose: at 1 Hz a live
 * chart region would interrupt a screen-reader user roughly once a second with
 * a number they did not ask for, which is not access — it is a denial of it.
 * So the numbers stay silent and remain available on demand (the chart carries
 * role="img" with a summary label), and this region announces only the events
 * a caregiver is waiting for: an alert changing state, a decision landing, and
 * the feed itself dropping or coming back — a monitor that has stopped
 * receiving is the one thing more urgent than what it last received.
 *
 * Since C20a that last clause has a second, sharper case. "Feed disconnected"
 * is this dashboard losing its socket; a silence episode is the DEVICE having
 * stopped, which the socket cannot report because a calm patient and a dead
 * link look identical from here. Both are announced, and they are worded so
 * they cannot be mistaken for each other.
 *
 * `polite` rather than `assertive` on purpose. Even a raised alert is not worth
 * cutting off whatever the user is reading mid-word; the visual timeline, the
 * badge, and the row order carry the same information without interrupting.
 */

function describeSilence(episode: DeviceSilenceEvent): string {
  if (episode.state === "resolved") return "Device sending again";
  return "No data from device";
}

function describe(alert: AlertEvent): string {
  const metric = alert.metric === "spo2Pct" ? "SpO2" : alert.metric;
  if (alert.state === "resolved") return `${metric} ${alert.direction} alert resolved`;
  if (alert.state === "raised") return `${metric} ${alert.direction} alert raised`;
  return `${metric} ${alert.direction} alert ongoing`;
}

export function AlertAnnouncer(props: {
  alerts: readonly AlertEvent[];
  /** Episodes of the device sending nothing at all (C20a). */
  silence?: readonly DeviceSilenceEvent[];
  decisions: ReadonlyMap<string, AlertDecisionEvent>;
  connection?: ConnectionState;
}) {
  const [message, setMessage] = useState("");
  const seenAlerts = useRef(new Map<string, string>());
  const seenDecisions = useRef(new Set<string>());
  const seenConnection = useRef<ConnectionState | undefined>(undefined);
  const primed = useRef(false);

  useEffect(() => {
    const announcements: string[] = [];

    if (props.connection !== undefined && props.connection !== seenConnection.current) {
      const previous = seenConnection.current;
      seenConnection.current = props.connection;
      if (primed.current && previous !== undefined) {
        announcements.push(props.connection === "live" ? "Feed live" : `Feed ${props.connection}`);
      }
    }

    for (const alert of props.alerts) {
      const previous = seenAlerts.current.get(alert.alertId);
      if (previous !== alert.state) {
        seenAlerts.current.set(alert.alertId, alert.state);
        if (primed.current) announcements.push(describe(alert));
      }
    }

    for (const episode of props.silence ?? []) {
      const previous = seenAlerts.current.get(episode.alertId);
      if (previous !== episode.state) {
        seenAlerts.current.set(episode.alertId, episode.state);
        // `ongoing` is deliberately silent here. The server re-states an open
        // episode's duration on every sweep, and announcing that would be the
        // firehose this component exists to refuse — once, when it starts, and
        // once when it ends.
        if (primed.current && episode.state !== "ongoing") {
          announcements.push(describeSilence(episode));
        }
      }
    }

    for (const [alertId, decision] of props.decisions) {
      if (seenDecisions.current.has(decision.eventId)) continue;
      seenDecisions.current.add(decision.eventId);
      if (primed.current) {
        const alert = props.alerts.find((candidate) => candidate.alertId === alertId);
        // An alert that has aged out of the window still gets its decision
        // announced; only the metric it belonged to is no longer known.
        const subject = alert === undefined ? "An" : describe(alert).replace(/ alert .*/, "");
        announcements.push(`${subject} alert ${decision.decision} by ${decision.actor}`);
      }
    }

    // The first pass is the page loading, not news: announcing the whole
    // backlog on arrival would be the firehose in a different costume.
    if (!primed.current) {
      primed.current = true;
      return;
    }
    if (announcements.length > 0) setMessage(announcements.join(". "));
  }, [props.alerts, props.silence, props.decisions, props.connection]);

  return (
    <p className="mb-visually-hidden" role="status" aria-live="polite">
      {message}
    </p>
  );
}
