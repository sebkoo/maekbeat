import type { AlertEvent, AlertMetric } from "@maekbeat/protocol";

import type { StoredFrame } from "../api/contracts";
import {
  anchorToCapturedAt,
  domainFor,
  linearScale,
  prepareSeries,
  toPath,
  type Point,
} from "../chart/geometry";
import { formatClock, formatNumber } from "../format";

/*
 * One metric over time, as a small multiple. No dual axis: two metrics that
 * share a time axis get two charts, because a second y-scale invites the reader
 * to compare shapes that are not comparable.
 *
 * The x axis is capturedAtMs — device clock — per docs/ARCHITECTURE.md, where
 * drift shifts charts and never alerts. Alert marks carry server receive time,
 * so each is anchored to the frame nearest its raise rather than converted onto
 * a clock it does not belong to.
 */

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 168;
const PAD = { left: 46, right: 10, top: 12, bottom: 24 };

/** Buckets across the plot; two points per bucket keeps every local extreme. */
const BUCKETS = 150;

export interface VitalsChartProps {
  title: string;
  unit: string;
  metric: AlertMetric;
  frames: readonly StoredFrame[];
  alerts: readonly AlertEvent[];
  /** Smallest y-span, so a flat trace stays flat instead of showing jitter. */
  minSpan: number;
  digits: number;
}

export function VitalsChart(props: VitalsChartProps) {
  const { metric } = props;
  // Only the newest session is drawn. `sessionEpoch` bumps when a device
  // reboots or its seq regresses past the reorder window (docs/DECISIONS.md
  // #11), and a reboot may reset the device clock — so two sessions on one
  // capturedAtMs axis are not one trace, and joining them would invent a
  // shape neither session had.
  const session = props.frames.reduce((newest, frame) => Math.max(newest, frame.sessionEpoch), 0);
  const frames = props.frames.filter((frame) => frame.sessionEpoch === session);
  const earlierSessionFrames = props.frames.length - frames.length;
  const points: Point[] = frames.map((frame) => ({ x: frame.capturedAtMs, y: frame[metric] }));
  const first = points[0];
  const last = points[points.length - 1];

  if (first === undefined || last === undefined) {
    return (
      <figure className="mb-chart">
        <figcaption className="mb-chart__title">
          {props.title} <span className="mb-chart__unit">{props.unit}</span>
        </figcaption>
        <p className="mb-meta">No frames in the window yet.</p>
      </figure>
    );
  }

  const { segments, gaps } = prepareSeries(points, BUCKETS);
  const [low, high] = domainFor(
    points.map((point) => point.y),
    props.minSpan,
  );
  const scaleX = linearScale([first.x, last.x], [PAD.left, VIEW_WIDTH - PAD.right]);
  const scaleY = linearScale([low, high], [VIEW_HEIGHT - PAD.bottom, PAD.top]);

  const { anchored: marks, outsideWindow: unmarkedAlerts } = anchorToCapturedAt(
    props.alerts.filter((alert) => alert.metric === metric),
    frames,
  );
  const latest = last.y;
  const gapNote =
    gaps.length === 0
      ? "no coverage gaps"
      : `${gaps.length} coverage ${gaps.length === 1 ? "gap" : "gaps"}`;

  return (
    <figure className="mb-chart">
      <figcaption className="mb-chart__title">
        {props.title} <span className="mb-chart__unit">{props.unit}</span>
        <span className="mb-chart__latest">{formatNumber(latest, props.digits)}</span>
      </figcaption>
      <svg
        className="mb-chart__plot"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.title} in ${props.unit}, ${frames.length} samples, latest ${formatNumber(
          latest,
          props.digits,
        )}, ${gapNote}`}
      >
        {/* Gaps are drawn, not merely left empty: an outage is information. */}
        {gaps.map((gap) => (
          <rect
            key={`gap-${gap.from}`}
            className="mb-chart__gap"
            x={scaleX(gap.from)}
            y={PAD.top}
            width={Math.max(scaleX(gap.to) - scaleX(gap.from), 1)}
            height={VIEW_HEIGHT - PAD.bottom - PAD.top}
          />
        ))}

        {marks.map(({ alert, x }) => (
          <line
            key={`${alert.alertId}-${alert.state}`}
            className="mb-chart__alert"
            data-alert-state={alert.state}
            x1={scaleX(x)}
            x2={scaleX(x)}
            y1={PAD.top}
            y2={VIEW_HEIGHT - PAD.bottom}
          />
        ))}

        {/* One path per run of continuous coverage — never one across a hole. */}
        {segments.map((segment, index) => (
          <path
            key={`segment-${segment[0]?.x ?? index}`}
            className="mb-chart__line"
            d={toPath(segment, scaleX, scaleY)}
          />
        ))}

        <line
          className="mb-chart__axis"
          x1={PAD.left}
          x2={VIEW_WIDTH - PAD.right}
          y1={VIEW_HEIGHT - PAD.bottom}
          y2={VIEW_HEIGHT - PAD.bottom}
        />
        <text className="mb-chart__tick" x={PAD.left - 6} y={PAD.top + 6} textAnchor="end">
          {formatNumber(high, props.digits)}
        </text>
        <text
          className="mb-chart__tick"
          x={PAD.left - 6}
          y={VIEW_HEIGHT - PAD.bottom}
          textAnchor="end"
        >
          {formatNumber(low, props.digits)}
        </text>
        <text className="mb-chart__tick" x={PAD.left} y={VIEW_HEIGHT - 6}>
          {formatClock(first.x)}
        </text>
        <text
          className="mb-chart__tick"
          x={VIEW_WIDTH - PAD.right}
          y={VIEW_HEIGHT - 6}
          textAnchor="end"
        >
          {formatClock(last.x)}
        </text>
      </svg>
      <p className="mb-chart__note">
        {frames.length} samples · device clock · session {session} · {gapNote}
        {gaps.length > 0 ? " (shaded: no data received)" : ""}
        {earlierSessionFrames > 0
          ? ` · ${earlierSessionFrames} frames from earlier sessions not drawn`
          : ""}
        {unmarkedAlerts > 0 ? ` · ${unmarkedAlerts} alerts outside this window not marked` : ""}
      </p>
    </figure>
  );
}
