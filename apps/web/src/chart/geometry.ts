/*
 * Chart maths, kept free of the DOM so the two rules that matter can be tested
 * as arithmetic rather than as pixels:
 *
 *   1. A gap is a gap. Missing samples break the line; nothing is ever drawn
 *      across them. A trace that spans a 40-second outage claims coverage the
 *      system did not have, and on a monitoring surface that is a lie.
 *   2. Decimation must not eat the event. The viewport has fewer pixels than
 *      the ring has frames, so points must be dropped — but by min/max
 *      envelope, never by stride. Stride sampling drops whichever samples fall
 *      between its steps, and the single trough of an SpO2 desaturation is
 *      exactly the sample this project exists to show.
 */

export interface Point {
  /** capturedAtMs — device clock (docs/ARCHITECTURE.md; see the axis note in the README). */
  x: number;
  y: number;
}

/** A gap is this many times the median sample interval… */
export const GAP_FACTOR = 3;
/** …but never less than this, so a jittery 1 Hz stream is not all holes. */
export const MIN_GAP_MS = 2_500;

/**
 * The interval above which a hole is a coverage break, derived from the data
 * rather than hard-coded: devices may sample at different rates, and a fixed
 * threshold would either miss outages on slow devices or invent them on fast ones.
 */
export function gapThresholdMs(points: readonly Point[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous && current) deltas.push(current.x - previous.x);
  }
  if (deltas.length === 0) return MIN_GAP_MS;
  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1] ?? MIN_GAP_MS;
  return Math.max(median * GAP_FACTOR, MIN_GAP_MS);
}

/** Splits a series into the runs of continuous coverage between its gaps. */
export function splitAtGaps(points: readonly Point[], thresholdMs: number): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous !== undefined && point.x - previous.x > thresholdMs) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** The holes themselves, as [from, to] spans — drawn, not merely left blank. */
export function gapSpans(
  points: readonly Point[],
  thresholdMs: number,
): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous && current && current.x - previous.x > thresholdMs) {
      spans.push({ from: previous.x, to: current.x });
    }
  }
  return spans;
}

/**
 * Min/max envelope decimation. Each bucket contributes its lowest and highest
 * sample, in the order they occurred, so every local extreme in the window
 * survives — the trough of a desaturation cannot be sampled away.
 */
export function decimate(points: readonly Point[], buckets: number): Point[] {
  if (buckets < 1) throw new RangeError(`buckets must be >= 1, got ${buckets}`);
  if (points.length <= buckets * 2) return [...points];

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return [];

  const span = last.x - first.x;
  const kept: Point[] = [];
  let bucketStart = 0;

  for (let bucket = 0; bucket < buckets && bucketStart < points.length; bucket++) {
    const bucketEndX = span === 0 ? last.x : first.x + (span * (bucket + 1)) / buckets;

    let bucketEnd = bucketStart;
    while (bucketEnd < points.length) {
      const point = points[bucketEnd];
      if (point === undefined) break;
      if (bucket < buckets - 1 && point.x > bucketEndX) break;
      bucketEnd += 1;
    }
    if (bucketEnd === bucketStart) continue;

    let lowIndex = bucketStart;
    let highIndex = bucketStart;
    for (let i = bucketStart; i < bucketEnd; i++) {
      const point = points[i];
      const low = points[lowIndex];
      const high = points[highIndex];
      if (point === undefined || low === undefined || high === undefined) continue;
      if (point.y < low.y) lowIndex = i;
      if (point.y > high.y) highIndex = i;
    }

    const indices =
      lowIndex === highIndex ? [lowIndex] : [lowIndex, highIndex].sort((a, b) => a - b);
    for (const index of indices) {
      const point = points[index];
      if (point !== undefined) kept.push(point);
    }
    bucketStart = bucketEnd;
  }

  return kept;
}

/**
 * Gaps are found before decimation and each run is decimated on its own, so a
 * bucket can never bridge a hole: shrinking the point count must not quietly
 * restore coverage the data does not have.
 */
export function prepareSeries(
  points: readonly Point[],
  buckets: number,
): { segments: Point[][]; gaps: Array<{ from: number; to: number }>; thresholdMs: number } {
  const thresholdMs = gapThresholdMs(points);
  const runs = splitAtGaps(points, thresholdMs);
  const total = points.length || 1;
  const segments = runs.map((run) => {
    const share = Math.max(1, Math.round((buckets * run.length) / total));
    return decimate(run, share);
  });
  return { segments, gaps: gapSpans(points, thresholdMs), thresholdMs };
}

/**
 * A y-range that shows the shape without amplifying noise: the data range,
 * padded, widened to at least `minSpan` so a flat trace stays flat instead of
 * filling the panel with jitter.
 */
export function domainFor(values: readonly number[], minSpan: number): [number, number] {
  if (values.length === 0) return [0, minSpan];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const centre = (low + high) / 2;
  // Pad the data range first, then apply the floor, so `minSpan` is exactly
  // the span a flat trace gets rather than a padded approximation of it.
  const span = Math.max((high - low) * 1.1, minSpan);
  return [centre - span / 2, centre + span / 2];
}

export interface Scale {
  (value: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const spread = d1 - d0;
  return (value: number) =>
    spread === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / spread) * (r1 - r0);
}

/** An SVG path for one continuous run. Single points render as a short tick. */
export function toPath(points: readonly Point[], scaleX: Scale, scaleY: Scale): string {
  if (points.length === 0) return "";
  const commands = points.map((point, index) => {
    const x = scaleX(point.x).toFixed(2);
    const y = scaleY(point.y).toFixed(2);
    return `${index === 0 ? "M" : "L"}${x},${y}`;
  });
  if (points.length === 1)
    commands.push(
      `L${(scaleX(points[0]!.x) + 0.75).toFixed(2)},${scaleY(points[0]!.y).toFixed(2)}`,
    );
  return commands.join(" ");
}

/**
 * Places an alert on a device-clock axis by anchoring it to the frame nearest
 * its receive time. Alert timestamps are server receive time and the axis is
 * device capture time (docs/ARCHITECTURE.md), so a mark points at the sample
 * that raised it rather than at a converted timestamp that belongs to neither
 * clock.
 *
 * An alert raised outside the frame window is NOT anchored. Alerts are kept
 * per process lifetime (100 per device) while frames are a bounded ring, so
 * every older alert would otherwise pile onto the window's first frame and
 * claim an event at a time when nothing happened — the same lie as drawing a
 * line through an outage. Those are returned as a count for the caller to
 * admit to instead.
 */
export function anchorToCapturedAt<T extends { raisedAtMs: number }>(
  alerts: readonly T[],
  frames: readonly { capturedAtMs: number; receivedAtMs: number }[],
): { anchored: Array<{ alert: T; x: number }>; outsideWindow: number } {
  if (frames.length === 0) return { anchored: [], outsideWindow: alerts.length };

  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (frame.receivedAtMs < earliest) earliest = frame.receivedAtMs;
    if (frame.receivedAtMs > latest) latest = frame.receivedAtMs;
  }

  const anchored: Array<{ alert: T; x: number }> = [];
  let outsideWindow = 0;
  for (const alert of alerts) {
    if (alert.raisedAtMs < earliest || alert.raisedAtMs > latest) {
      outsideWindow += 1;
      continue;
    }
    let nearest = frames[0]!;
    let best = Math.abs(nearest.receivedAtMs - alert.raisedAtMs);
    for (const frame of frames) {
      const distance = Math.abs(frame.receivedAtMs - alert.raisedAtMs);
      if (distance < best) {
        best = distance;
        nearest = frame;
      }
    }
    anchored.push({ alert, x: nearest.capturedAtMs });
  }
  return { anchored, outsideWindow };
}
