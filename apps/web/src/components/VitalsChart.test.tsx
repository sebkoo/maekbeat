import type { AlertEvent } from "@maekbeat/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StoredFrame } from "../api/contracts";
import { VitalsChart } from "./VitalsChart";

const BASE_MS = 1_754_000_000_000;

function frames(count: number, spo2: (i: number) => number, startMs = BASE_MS, seq0 = 0) {
  return Array.from({ length: count }, (_, i): StoredFrame => {
    const capturedAtMs = startMs + i * 1_000;
    return {
      v: 1,
      deviceId: "dev-1",
      seq: seq0 + i,
      capturedAtMs,
      heartRateBpm: 70,
      spo2Pct: spo2(i),
      respirationRpm: 14,
      motion: 0.1,
      receivedAtMs: capturedAtMs + 200,
      sessionEpoch: 1,
    };
  });
}

function chart(props: Partial<Parameters<typeof VitalsChart>[0]> = {}) {
  return render(
    <VitalsChart
      title="SpO2"
      unit="%"
      metric="spo2Pct"
      frames={props.frames ?? frames(30, () => 97)}
      alerts={props.alerts ?? []}
      minSpan={props.minSpan ?? 6}
      digits={props.digits ?? 1}
    />,
  );
}

/** The x coordinates of one path's points, in order. */
function pathXs(path: Element): number[] {
  const d = path.getAttribute("d") ?? "";
  return [...d.matchAll(/[ML](-?[\d.]+),/g)].map(([, x]) => Number(x));
}

/** The y coordinates of one path's points, in order. */
function pathYs(path: Element): number[] {
  const d = path.getAttribute("d") ?? "";
  return [...d.matchAll(/[ML]-?[\d.]+,(-?[\d.]+)/g)].map(([, y]) => Number(y));
}

describe("VitalsChart", () => {
  it("draws one continuous line when coverage is continuous", () => {
    chart();
    expect(document.querySelectorAll(".mb-chart__line")).toHaveLength(1);
    expect(document.querySelectorAll(".mb-chart__gap")).toHaveLength(0);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("no coverage gaps");
  });

  // The honesty rule of C11: a chart that draws through an outage claims
  // coverage the system did not have.
  it("breaks the line across a 40-second hole instead of drawing through it", () => {
    const before = frames(30, () => 97);
    const after = frames(30, () => 95, before[29]!.capturedAtMs + 40_000, 30);
    chart({ frames: [...before, ...after] });

    const gaps = document.querySelectorAll(".mb-chart__gap");
    expect(gaps).toHaveLength(1);

    const lines = [...document.querySelectorAll(".mb-chart__line")];
    expect(lines).toHaveLength(2);

    // The assertion that fails the moment interpolation returns: the band the
    // gap rect covers must not be crossed by any segment of any path.
    const gapRect = gaps[0]!;
    const gapStart = Number(gapRect.getAttribute("x"));
    const gapEnd = gapStart + Number(gapRect.getAttribute("width"));
    for (const line of lines) {
      const xs = pathXs(line);
      // Guard against the check going vacuous if the path format ever changes.
      expect(xs.length).toBeGreaterThan(1);
      for (let i = 1; i < xs.length; i++) {
        const crosses = xs[i - 1]! <= gapStart + 0.01 && xs[i]! >= gapEnd - 0.01;
        expect(crosses, `a path segment spans the gap: ${xs[i - 1]} → ${xs[i]}`).toBe(false);
      }
    }
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("1 coverage gap");
  });

  it("counts more than one hole, in plural", () => {
    const a = frames(20, () => 97);
    const b = frames(20, () => 96, a[19]!.capturedAtMs + 40_000, 20);
    const c = frames(20, () => 95, b[19]!.capturedAtMs + 40_000, 40);
    chart({ frames: [...a, ...b, ...c] });

    expect(document.querySelectorAll(".mb-chart__gap")).toHaveLength(2);
    expect(document.querySelectorAll(".mb-chart__line")).toHaveLength(3);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("2 coverage gaps");
  });

  it("keeps the gap visible after decimation has thinned the series", () => {
    // Far more samples than buckets, so every run must be decimated.
    const before = frames(600, (i) => 97 - (i % 2) * 0.2);
    const after = frames(600, () => 95, before[599]!.capturedAtMs + 60_000, 600);
    chart({ frames: [...before, ...after] });

    expect(document.querySelectorAll(".mb-chart__gap")).toHaveLength(1);
    expect(document.querySelectorAll(".mb-chart__line")).toHaveLength(2);
  });

  it("draws the desaturation trough that stride sampling would have dropped", () => {
    const troughIndex = 401;
    const series = frames(900, (i) => (i === troughIndex ? 84.2 : 97));
    chart({ frames: series });

    // Assert on the drawn path, not on the axis: the y domain is computed from
    // the undecimated series, so an axis tick would read the same even if
    // decimation had thrown the trough away. Only the path proves it survived.
    const ys = pathYs(document.querySelector(".mb-chart__line")!);
    expect(ys.length).toBeGreaterThan(1);
    // Every 97% sample lands on one y; the trough is far below it (y grows
    // downwards), so a stride sampler that dropped it leaves a flat path.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50);
  });

  it("marks alerts by lifecycle state, with the palette the badges use", () => {
    const series = frames(30, () => 97);
    const alerts: AlertEvent[] = [
      {
        alertId: "a1",
        deviceId: "dev-1",
        metric: "spo2Pct",
        direction: "low",
        state: "raised",
        raisedAtMs: series[10]!.receivedAtMs,
        windowStats: {
          windowMs: 15_000,
          sampleCount: 15,
          breachCount: 5,
          minValue: 86,
          maxValue: 94,
        },
      },
      {
        alertId: "a2",
        deviceId: "dev-1",
        metric: "heartRateBpm",
        direction: "high",
        state: "ongoing",
        raisedAtMs: series[20]!.receivedAtMs,
        windowStats: {
          windowMs: 15_000,
          sampleCount: 15,
          breachCount: 5,
          minValue: 150,
          maxValue: 190,
        },
      },
    ];
    chart({ frames: series, alerts });

    // Only this chart's metric is marked; the heart-rate alert belongs to the
    // other small multiple.
    const marks = [...document.querySelectorAll(".mb-chart__alert")];
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("data-alert-state")).toBe("raised");
  });

  // Alerts are kept per process lifetime while frames are a bounded ring, so
  // an old alert has no place on this window's axis.
  it("refuses to mark an alert raised outside the window, and admits to it", () => {
    const series = frames(30, () => 97);
    const stale: AlertEvent = {
      alertId: "old",
      deviceId: "dev-1",
      metric: "spo2Pct",
      direction: "low",
      state: "raised",
      raisedAtMs: series[0]!.receivedAtMs - 600_000,
      windowStats: {
        windowMs: 15_000,
        sampleCount: 15,
        breachCount: 5,
        minValue: 86,
        maxValue: 94,
      },
    };
    chart({ frames: series, alerts: [stale] });

    expect(document.querySelectorAll(".mb-chart__alert")).toHaveLength(0);
    screen.getByText(/1 alerts outside this window not marked/);
  });

  // A reboot may reset the device clock, so the two sessions share an axis
  // they do not share a meaning on.
  it("draws only the newest session, and says how much it left out", () => {
    const older = frames(20, () => 97).map((frame) => ({ ...frame, sessionEpoch: 1 }));
    const rebooted = frames(10, () => 88, BASE_MS, 0).map((frame) => ({
      ...frame,
      sessionEpoch: 2,
    }));
    chart({ frames: [...older, ...rebooted] });

    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("10 samples");
    screen.getByText(/session 2/);
    screen.getByText(/20 frames from earlier sessions not drawn/);
  });

  it("says the window is empty instead of drawing an empty axis", () => {
    chart({ frames: [] });
    expect(screen.getByText("No frames in the window yet.")).toBeDefined();
    expect(document.querySelector("svg")).toBeNull();
  });

  it("labels the axis with the metric's unit and the device clock", () => {
    chart();
    expect(screen.getByText("%")).toBeDefined();
    expect(screen.getByText(/device clock/)).toBeDefined();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("30 samples");
  });
});
