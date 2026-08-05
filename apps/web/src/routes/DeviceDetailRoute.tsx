import { useParams } from "react-router";

import { AlertStateBadge } from "../components/AlertStateBadge";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { ReadFailure, StatusPanel } from "../components/StatusPanel";
import { VitalsChart } from "../components/VitalsChart";
import { useLiveDevice } from "../data/useLiveDevice";
import { formatDelta, formatInstant, formatNumber } from "../format";

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
 * One device, live since C11: a REST read on mount, then the fan-out socket
 * (apps/server GET /devices/:deviceId/stream) appended to it, with the
 * connection's own state on screen next to the data it explains.
 */
export function DeviceDetailRoute() {
  const { deviceId = "" } = useParams<{ deviceId: string }>();
  const { state, reload, connection, malformed } = useLiveDevice(deviceId);

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

  const { frames, alerts, counters } = state.data;
  const latest = frames[frames.length - 1];

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
      <div className="mb-page__heading">
        <h1 className="mb-page__title">{deviceId}</h1>
        <ConnectionBadge state={connection} />
      </div>
      <p className="mb-page__lead">
        Live over the fan-out socket, seeded and re-seeded from the REST window. Values are
        synthetic — see the disclaimer above.
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
          {malformed > 0
            ? ` · ${malformed} malformed ${malformed === 1 ? "message" : "messages"} dropped`
            : ""}
        </p>
      </section>

      <section className="mb-card">
        <h2 className="mb-card__title">Vitals over time</h2>
        <VitalsChart
          title="SpO2"
          unit="%"
          metric="spo2Pct"
          frames={frames}
          alerts={alerts}
          minSpan={6}
          digits={1}
        />
        <VitalsChart
          title="Heart rate"
          unit="bpm"
          metric="heartRateBpm"
          frames={frames}
          alerts={alerts}
          minSpan={20}
          digits={0}
        />
        <p className="mb-meta">
          Time is the device clock (`capturedAtMs`), so a drifting device slides its whole trace
          against the alert marks, which carry server receive time — the policy in
          docs/ARCHITECTURE.md, where drift shifts charts and never alerts. The delta above is that
          drift for the newest frame. Each mark sits on the frame nearest the alert&rsquo;s raise.
        </p>
      </section>

      <section className="mb-card">
        <h2 className="mb-card__title">Alerts</h2>
        <p className="mb-meta">
          At the last REST read: {counters.raised} raised · {counters.resolved} resolved ·{" "}
          {counters.suppressed} suppressed. A suppressed episode leaves no record to stream, so that
          number moves only when the window is re-read. Thresholds are demo heuristics, not clinical
          rules.
        </p>
        {alerts.length === 0 ? (
          <p className="mb-meta">No alerts recorded for this device.</p>
        ) : (
          // Keyed by alertId alone: it is stable across state changes by
          // contract (packages/protocol), and C12 hangs acknowledgement off
          // this row — a key that moved on transition would remount it.
          <ul className="mb-alert-list">
            {alerts.map((alert) => (
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
