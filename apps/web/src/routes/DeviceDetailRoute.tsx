import { useParams } from "react-router";

import { AlertStateBadge } from "../components/AlertStateBadge";
import { ReadFailure, StatusPanel } from "../components/StatusPanel";
import { useApi } from "../data/api-context";
import { useAsync } from "../data/useAsync";
import { formatDelta, formatInstant, formatNumber } from "../format";

/** Frames pulled per mount; the server caps `limit` at 1000 (apps/server/README.md). */
const FRAME_LIMIT = 50;

function Metric(props: { label: string; value: string; unit: string }) {
  return (
    <div className="mb-metric">
      <span className="mb-metric__label">{props.label}</span>
      <span className="mb-metric__value">
        {props.value}
        <span className="mb-metric__unit">{props.unit}</span>
      </span>
    </div>
  );
}

/**
 * One device: its most recent frame and its alert lifecycle records, both read
 * once per mount over REST. The chart slot is a labelled placeholder until
 * C11 — an empty axis pretending to be a live trace would be a lie about a
 * monitoring surface.
 */
export function DeviceDetailRoute() {
  const api = useApi();
  const { deviceId = "" } = useParams<{ deviceId: string }>();
  const { state, reload } = useAsync(
    async (signal) => {
      const [frames, alerts] = await Promise.all([
        api.readFrames(deviceId, { limit: FRAME_LIMIT }, signal),
        api.readAlerts(deviceId, signal),
      ]);
      return { frames, alerts };
    },
    [api, deviceId],
  );

  if (state.status === "loading") {
    return (
      <StatusPanel
        variant="loading"
        headingLevel={1}
        title="Reading device"
        detail={`Asking the Maekbeat API for frames and alerts from ${deviceId}.`}
      />
    );
  }

  if (state.status === "error") {
    return <ReadFailure error={state.error} onRetry={reload} headingLevel={1} />;
  }

  const { frames, alerts } = state.data;
  const latest = frames.frames[frames.frames.length - 1];

  if (latest === undefined) {
    return (
      <StatusPanel
        variant="empty"
        headingLevel={1}
        title="No data yet"
        detail={`The server knows ${deviceId} but its window holds no frames right now.`}
        onRetry={reload}
      />
    );
  }

  return (
    <>
      <h1 className="mb-page__title">{deviceId}</h1>
      <p className="mb-page__lead">
        Latest of {frames.count} frames in the server&rsquo;s window, ordered by capture time.
        Values are synthetic — see the disclaimer above.
      </p>

      <section className="mb-card">
        <h2 className="mb-card__title">Latest frame</h2>
        <div className="mb-metrics">
          <Metric label="Heart rate" value={formatNumber(latest.heartRateBpm)} unit="bpm" />
          <Metric label="SpO2" value={formatNumber(latest.spo2Pct, 1)} unit="%" />
          <Metric label="Respiration" value={formatNumber(latest.respirationRpm, 1)} unit="rpm" />
          <Metric label="Motion" value={formatNumber(latest.motion, 2)} unit="0–1" />
        </div>
        <p className="mb-meta">
          Captured {formatInstant(latest.capturedAtMs)} · received{" "}
          {formatInstant(latest.receivedAtMs)} · clock delta{" "}
          {formatDelta(latest.receivedAtMs - latest.capturedAtMs)} · seq {latest.seq} · session{" "}
          {latest.sessionEpoch}
        </p>
      </section>

      <section className="mb-card">
        <h2 className="mb-card__title">Vitals over time</h2>
        <div className="mb-placeholder">
          The live chart lands at C11, streaming over the WebSocket fan-out. This slot stays a
          labelled placeholder until then rather than drawing a trace that is not live.
        </div>
      </section>

      <section className="mb-card">
        <h2 className="mb-card__title">Alerts</h2>
        <p className="mb-meta">
          {alerts.counters.raised} raised · {alerts.counters.resolved} resolved ·{" "}
          {alerts.counters.suppressed} suppressed. Thresholds are demo heuristics, not clinical
          rules.
        </p>
        {alerts.alerts.length === 0 ? (
          <p className="mb-meta">No alerts recorded for this device.</p>
        ) : (
          // Keyed by alertId alone: it is stable across state changes by
          // contract (packages/protocol), and C12 hangs acknowledgement off
          // this row — a key that moved on transition would remount it.
          <ul className="mb-alert-list">
            {alerts.alerts.map((alert) => (
              <li className="mb-alert-row" key={alert.alertId}>
                <span>
                  <AlertStateBadge state={alert.state} /> {alert.metric} {alert.direction}
                </span>
                <span className="mb-alert-row__meta">
                  raised {formatInstant(alert.raisedAtMs)}
                  {alert.resolvedAtMs === undefined
                    ? ""
                    : ` · resolved ${formatInstant(alert.resolvedAtMs)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
