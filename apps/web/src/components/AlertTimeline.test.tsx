import type { AlertDecisionEvent, AlertEvent } from "@maekbeat/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AlertTimeline, episodeDurationMs, formatDuration } from "./AlertTimeline";

const BASE_MS = 1_754_000_000_000;

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    alertId: "dev-1:spo2-low:1",
    deviceId: "dev-1",
    metric: "spo2Pct",
    direction: "low",
    state: "raised",
    raisedAtMs: BASE_MS,
    windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
    ...overrides,
  };
}

function timeline(props: Partial<Parameters<typeof AlertTimeline>[0]> = {}) {
  const onDecide = props.onDecide ?? vi.fn();
  render(
    <AlertTimeline
      alerts={props.alerts ?? [alert()]}
      decisions={props.decisions ?? new Map()}
      pending={props.pending ?? new Set()}
      failures={props.failures ?? new Map()}
      nowMs={props.nowMs ?? BASE_MS + 30_000}
      onDecide={onDecide}
    />,
  );
  return { onDecide };
}

describe("episode duration", () => {
  it("measures a live episode against now and a closed one against its resolve", () => {
    expect(episodeDurationMs(alert(), BASE_MS + 30_000)).toBe(30_000);
    expect(episodeDurationMs(alert({ resolvedAtMs: BASE_MS + 53_000 }), BASE_MS + 90_000)).toBe(
      53_000,
    );
    // A resolve stamp before the raise cannot produce a negative duration.
    expect(episodeDurationMs(alert({ resolvedAtMs: BASE_MS - 1_000 }), BASE_MS)).toBe(0);
  });

  it("reads seconds under a minute and minutes above it", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(53_000)).toBe("53s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(605_000)).toBe("10m 05s");
  });
});

describe("AlertTimeline", () => {
  // One record in, one row out, carrying the episode's duration rather than
  // its transition count. That a whole lifecycle arrives as ONE record is the
  // hook's guarantee, asserted end to end in src/App.test.tsx.
  it("renders an episode as a single row with its duration", () => {
    timeline({
      alerts: [alert({ state: "resolved", resolvedAtMs: BASE_MS + 53_000 })],
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("53s")).toBeDefined();
    expect(screen.getAllByRole("listitem")[0]?.getAttribute("data-alert-state")).toBe("resolved");
  });

  it("puts the newest episode first", () => {
    timeline({
      alerts: [
        alert({ alertId: "older", raisedAtMs: BASE_MS }),
        alert({
          alertId: "newer",
          metric: "heartRateBpm",
          direction: "high",
          raisedAtMs: BASE_MS + 60_000,
        }),
      ],
      nowMs: BASE_MS + 90_000,
    });

    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("heartRateBpm high");
    expect(rows[1]).toContain("spo2Pct low");
  });

  it("says a live episode is still running rather than implying it ended", () => {
    timeline({ alerts: [alert({ state: "ongoing" })] });
    expect(screen.getByText("30s and counting")).toBeDefined();
  });

  it("offers both decisions, and tells them apart for a screen reader", () => {
    timeline();

    expect(screen.getByRole("button", { name: /Acknowledge spo2Pct low alert/ })).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Dismiss spo2Pct low alert as not actionable/ }),
    ).toBeDefined();
  });

  it("reports a decision in force instead of the buttons", () => {
    const decision: AlertDecisionEvent = {
      eventId: "e1",
      alertId: "dev-1:spo2-low:1",
      deviceId: "dev-1",
      decision: "dismissed",
      actor: "night-shift",
      recordedAtMs: BASE_MS + 70_000,
    };
    timeline({ decisions: new Map([[decision.alertId, decision]]) });

    expect(screen.getByText(/Dismissed by night-shift/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).toBeNull();
  });

  it("disables the controls while a decision is in flight", () => {
    timeline({ pending: new Set(["dev-1:spo2-low:1"]) });

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
    }
  });

  it("shows a failed decision as a failure, not as a decision", () => {
    timeline({ failures: new Map([["dev-1:spo2-low:1", "unknown alert"]]) });

    expect(screen.getByRole("alert").textContent).toContain("Not recorded: unknown alert");
    // The buttons come back: the alert is still unjudged.
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeDefined();
  });

  // The server's decision log outlives its bounded alert history, so a
  // decision can survive its alert. Dropping the row would lose the only
  // record that anyone triaged the event.
  it("still shows a decision whose alert the server no longer retains", () => {
    const orphan: AlertDecisionEvent = {
      eventId: "e9",
      alertId: "dev-1:spo2-low:1754000000000:1",
      deviceId: "dev-1",
      decision: "acknowledged",
      actor: "night-shift",
      recordedAtMs: BASE_MS + 5_000,
    };
    timeline({ alerts: [], decisions: new Map([[orphan.alertId, orphan]]) });

    expect(screen.getByText("Decided, alert no longer retained")).toBeDefined();
    expect(screen.getByText(/Acknowledged by night-shift/)).toBeDefined();
    expect(screen.getByText(orphan.alertId)).toBeDefined();
  });

  it("keeps a retained alert out of the orphan list", () => {
    const decision: AlertDecisionEvent = {
      eventId: "e1",
      alertId: "dev-1:spo2-low:1",
      deviceId: "dev-1",
      decision: "acknowledged",
      actor: "night-shift",
      recordedAtMs: BASE_MS + 5_000,
    };
    timeline({
      alerts: [alert({ alertId: decision.alertId })],
      decisions: new Map([[decision.alertId, decision]]),
    });

    expect(screen.queryByText("Decided, alert no longer retained")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("says so when there is nothing to show", () => {
    timeline({ alerts: [] });
    expect(screen.getByText("No alerts recorded for this device.")).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("reports which decision was asked for", () => {
    const { onDecide } = timeline();

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    expect(onDecide).toHaveBeenCalledWith("dev-1:spo2-low:1", "acknowledged");

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(onDecide).toHaveBeenCalledWith("dev-1:spo2-low:1", "dismissed");
  });
});
