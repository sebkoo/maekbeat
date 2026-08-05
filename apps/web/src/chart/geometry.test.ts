import { describe, expect, it } from "vitest";

import {
  anchorToCapturedAt,
  decimate,
  domainFor,
  gapSpans,
  gapThresholdMs,
  linearScale,
  prepareSeries,
  splitAtGaps,
  toPath,
  type Point,
} from "./geometry";

/** MIN_GAP_MS, restated here so the test pins the value rather than reads it. */
const MIN_GAP_FLOOR = 2_500;

/** A 1 Hz series, the vitals-sim cadence (tickMs 1000). */
function series(count: number, value: (i: number) => number, startMs = 1_754_000_000_000): Point[] {
  return Array.from({ length: count }, (_, i) => ({ x: startMs + i * 1_000, y: value(i) }));
}

/** What naive decimation would do — the thing this module must not be. */
function stride(points: readonly Point[], keep: number): Point[] {
  const step = Math.ceil(points.length / keep);
  return points.filter((_, index) => index % step === 0);
}

describe("gap detection", () => {
  it("derives the threshold from the sample rate instead of hard-coding it", () => {
    // vitals-sim runs at 1 Hz: three missed ticks is an outage.
    expect(gapThresholdMs(series(20, () => 97))).toBe(3_000);
    // A 10 s cadence stretches with it…
    const slow = Array.from({ length: 10 }, (_, i) => ({ x: i * 10_000, y: 97 }));
    expect(gapThresholdMs(slow)).toBe(30_000);
    // …while a 200 ms cadence hits the floor, so jitter is not read as loss.
    const fast = Array.from({ length: 10 }, (_, i) => ({ x: i * 200, y: 97 }));
    expect(gapThresholdMs(fast)).toBe(MIN_GAP_FLOOR);
    expect(gapThresholdMs([])).toBe(MIN_GAP_FLOOR);
  });

  it("treats one missed sample as jitter, not as an outage", () => {
    const points = [...series(5, () => 97)];
    points.push({ x: points[4]!.x + 2_000, y: 97 });
    expect(splitAtGaps(points, gapThresholdMs(points))).toHaveLength(1);
  });

  it("breaks the line across a 40-second hole and reports the span", () => {
    const before = series(20, () => 97);
    const after = series(20, () => 96, before[19]!.x + 40_000);
    const points = [...before, ...after];
    const threshold = gapThresholdMs(points);

    const segments = splitAtGaps(points, threshold);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(20);
    expect(gapSpans(points, threshold)).toEqual([{ from: before[19]!.x, to: after[0]!.x }]);
  });

  it("never emits a segment that spans a gap, however few buckets remain", () => {
    // Both runs carry shape, so decimation keeps two points per bucket and the
    // per-point checks below actually execute — a flat run collapses to one
    // point per bucket and would leave this test asserting nothing.
    const before = series(200, (i) => 97 + (i % 7) * 0.2);
    const after = series(200, (i) => 95 + (i % 7) * 0.2, before[199]!.x + 40_000);
    const points = [...before, ...after];

    // Two buckets total: a bucket-first implementation would merge the hole.
    const { segments, gaps } = prepareSeries(points, 2);
    expect(gaps).toHaveLength(1);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(1);
      for (let i = 1; i < segment.length; i++) {
        expect(segment[i]!.x - segment[i - 1]!.x).toBeLessThan(40_000);
      }
    }
    // Each kept point stays inside its own run's span: no point may migrate
    // across the hole, which is what a bucket spanning it would produce.
    const firstRunEnd = before[199]!.x;
    for (const point of segments[0]!) expect(point.x).toBeLessThanOrEqual(firstRunEnd);
    for (const point of segments[1]!) expect(point.x).toBeGreaterThan(firstRunEnd);
  });
});

describe("decimation keeps the event", () => {
  // A desaturation trough one sample wide, deliberately placed where a stride
  // sampler steps over it. This is the signal the whole project exists to show.
  const TROUGH_INDEX = 137;
  const TROUGH_VALUE = 84.2;
  const points = series(400, (i) => (i === TROUGH_INDEX ? TROUGH_VALUE : 97 + (i % 3) * 0.1));

  it("keeps the single-sample trough that stride sampling drops", () => {
    const kept = decimate(points, 40).map((point) => point.y);
    expect(kept).toContain(TROUGH_VALUE);

    // The control: the naive alternative loses it, so this test fails if the
    // implementation is ever swapped for stride sampling.
    expect(stride(points, 40).map((point) => point.y)).not.toContain(TROUGH_VALUE);
  });

  it("keeps both extremes of every bucket, in the order they happened", () => {
    const wave = series(200, (i) => Math.sin(i / 5) * 10 + 90);
    const kept = decimate(wave, 20);
    expect(Math.min(...kept.map((p) => p.y))).toBe(Math.min(...wave.map((p) => p.y)));
    expect(Math.max(...kept.map((p) => p.y))).toBe(Math.max(...wave.map((p) => p.y)));
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i]!.x).toBeGreaterThanOrEqual(kept[i - 1]!.x);
    }
  });

  it("shrinks the series to roughly two points per bucket", () => {
    expect(decimate(points, 40).length).toBeLessThanOrEqual(80);
    expect(decimate(points, 40).length).toBeGreaterThan(0);
  });

  it("leaves a series smaller than the budget untouched", () => {
    const few = series(10, (i) => 90 + i);
    expect(decimate(few, 40)).toEqual(few);
  });

  it("handles buckets no sample falls into", () => {
    // Two tight clusters far apart: most buckets between them are empty.
    const early = series(50, () => 97);
    const late = series(50, () => 95, early[49]!.x + 500_000);
    const kept = decimate([...early, ...late], 20);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((point) => point.y)).toContain(95);
    expect(kept.map((point) => point.y)).toContain(97);
  });

  it("handles a series with no time span at all", () => {
    const stacked = Array.from({ length: 40 }, (_, i) => ({ x: 1_000, y: 90 + (i % 5) }));
    const kept = decimate(stacked, 4);
    expect(Math.min(...kept.map((p) => p.y))).toBe(90);
    expect(Math.max(...kept.map((p) => p.y))).toBe(94);
  });

  it("survives a flat series and a single point", () => {
    const flat = series(100, () => 97);
    expect(decimate(flat, 5).length).toBeGreaterThan(0);
    expect(decimate([{ x: 1, y: 1 }], 5)).toEqual([{ x: 1, y: 1 }]);
    expect(decimate([], 5)).toEqual([]);
    expect(() => decimate(points, 0)).toThrow(RangeError);
  });

  it("keeps the trough through the full pipeline, gaps and all", () => {
    const withGap = [...points, ...series(100, () => 96, points[399]!.x + 40_000)];
    const { segments } = prepareSeries(withGap, 30);
    expect(segments.flat().map((point) => point.y)).toContain(TROUGH_VALUE);
  });
});

describe("scales and paths", () => {
  it("widens a flat domain to the minimum span instead of magnifying noise", () => {
    expect(domainFor([97, 97, 97], 6)).toEqual([94, 100]);
    const [low, high] = domainFor([90, 100], 6);
    expect(low).toBeLessThan(90);
    expect(high).toBeGreaterThan(100);
    expect(domainFor([], 6)).toEqual([0, 6]);
  });

  it("maps a domain onto a pixel range, and a zero span to its middle", () => {
    const scale = linearScale([0, 10], [0, 100]);
    expect(scale(0)).toBe(0);
    expect(scale(10)).toBe(100);
    expect(scale(5)).toBe(50);
    expect(linearScale([5, 5], [0, 100])(5)).toBe(50);
  });

  it("writes one move and then lines, and gives a lone sample a visible tick", () => {
    const scaleX = linearScale([0, 10], [0, 10]);
    const scaleY = linearScale([0, 10], [10, 0]);
    expect(
      toPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        scaleX,
        scaleY,
      ),
    ).toBe("M0.00,10.00 L10.00,0.00");
    expect(toPath([{ x: 5, y: 5 }], scaleX, scaleY)).toBe("M5.00,5.00 L5.75,5.00");
    expect(toPath([], scaleX, scaleY)).toBe("");
  });
});

describe("alert anchoring", () => {
  // Alerts carry server receive time; the axis is device capture time. A
  // drifting device must not drag its alert marks off its own trace.
  const FRAMES = [
    { capturedAtMs: 1_000, receivedAtMs: 61_000 },
    { capturedAtMs: 2_000, receivedAtMs: 62_000 },
    { capturedAtMs: 3_000, receivedAtMs: 63_000 },
  ];

  it("anchors an alert to the frame nearest its receive time", () => {
    const { anchored, outsideWindow } = anchorToCapturedAt([{ raisedAtMs: 62_400 }], FRAMES);
    expect(anchored[0]?.x).toBe(2_000);
    expect(outsideWindow).toBe(0);
  });

  // Alerts outlive the frame ring, so an old one must not be dragged onto the
  // window's edge and claim an event where none happened.
  it("refuses to anchor an alert from outside the window", () => {
    const { anchored, outsideWindow } = anchorToCapturedAt(
      [{ raisedAtMs: 1_000 }, { raisedAtMs: 62_000 }, { raisedAtMs: 999_000 }],
      FRAMES,
    );
    expect(anchored.map((mark) => mark.x)).toEqual([2_000]);
    expect(outsideWindow).toBe(2);
  });

  it("counts every alert as unanchorable when the window is empty", () => {
    expect(anchorToCapturedAt([{ raisedAtMs: 1 }], [])).toEqual({
      anchored: [],
      outsideWindow: 1,
    });
  });
});
