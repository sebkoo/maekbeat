import { Link } from "react-router";

import { StatusPanel, ReadFailure } from "../components/StatusPanel";
import { useApi } from "../data/api-context";
import { useAsync } from "../data/useAsync";
import { formatInstant } from "../format";

/**
 * The device list: one REST read of `GET /devices` per mount. It is a snapshot
 * of the server's ring-buffer window, not a live view — the WebSocket stream
 * lands at C11 (docs/ROADMAP.md), and the page says so rather than implying
 * numbers are current.
 */
export function DeviceListRoute() {
  const api = useApi();
  const { state, reload } = useAsync((signal) => api.listDevices(signal), [api]);

  return (
    <>
      <h1 className="mb-page__title">Devices</h1>
      <p className="mb-page__lead">
        Every device apps/server has ingested this process lifetime, read once when this page
        loaded. Live streaming and the vitals chart land at C11.
      </p>

      {state.status === "loading" ? (
        <StatusPanel
          variant="loading"
          title="Reading devices"
          detail="Asking the Maekbeat API for the devices it has seen."
        />
      ) : null}

      {state.status === "error" ? <ReadFailure error={state.error} onRetry={reload} /> : null}

      {state.status === "ready" && state.data.devices.length === 0 ? (
        <StatusPanel
          variant="empty"
          title="No data yet"
          detail="The server is reachable and has ingested no frames. Start the pipeline with: pnpm --filter @maekbeat/server demo"
          onRetry={reload}
        />
      ) : null}

      {state.status === "ready" && state.data.devices.length > 0 ? (
        <>
          <section className="mb-card">
            <h2 className="mb-card__title">Reporting devices</h2>
            <table className="mb-table">
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Session</th>
                  <th scope="col">Frames</th>
                  <th scope="col">Last seq</th>
                  <th scope="col">Last frame received</th>
                  <th scope="col">Duplicates</th>
                </tr>
              </thead>
              <tbody>
                {state.data.devices.map((device) => (
                  <tr key={device.deviceId}>
                    <td>
                      <Link
                        className="mb-link"
                        to={`/devices/${encodeURIComponent(device.deviceId)}`}
                      >
                        {device.deviceId}
                      </Link>
                    </td>
                    <td className="mb-table__numeric">{device.sessionEpoch}</td>
                    <td className="mb-table__numeric">{device.frameCount}</td>
                    <td className="mb-table__numeric">{device.lastSeq}</td>
                    <td className="mb-table__numeric">{formatInstant(device.lastReceivedAtMs)}</td>
                    <td className="mb-table__numeric">{device.duplicatesDropped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="mb-card">
            <h2 className="mb-card__title">Ingest counters</h2>
            <p className="mb-meta">
              Process lifetime: {state.data.ingest.received} received · {state.data.ingest.accepted}{" "}
              accepted · {state.data.ingest.rejectedInvalid} rejected as invalid ·{" "}
              {state.data.ingest.duplicatesDropped} duplicates dropped ·{" "}
              {state.data.ingest.sessionsStarted} sessions started.
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
