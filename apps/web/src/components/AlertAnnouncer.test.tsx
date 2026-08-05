import type { AlertDecisionEvent, AlertEvent } from "@maekbeat/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AlertAnnouncer } from "./AlertAnnouncer";

const BASE_MS = 1_754_000_000_000;

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    alertId: "a1",
    deviceId: "dev-1",
    metric: "spo2Pct",
    direction: "low",
    state: "raised",
    raisedAtMs: BASE_MS,
    windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
    ...overrides,
  };
}

function decision(overrides: Partial<AlertDecisionEvent> = {}): AlertDecisionEvent {
  return {
    eventId: "e1",
    alertId: "a1",
    deviceId: "dev-1",
    decision: "acknowledged",
    actor: "night-shift",
    recordedAtMs: BASE_MS + 60_000,
    ...overrides,
  };
}

const live = () => screen.getByRole("status").textContent;

describe("AlertAnnouncer", () => {
  it("says nothing about the backlog it arrives to", () => {
    render(<AlertAnnouncer alerts={[alert(), alert({ alertId: "a2" })]} decisions={new Map()} />);
    expect(live()).toBe("");
  });

  it("announces a transition, naming the metric the way a person says it", () => {
    const { rerender } = render(<AlertAnnouncer alerts={[]} decisions={new Map()} />);

    rerender(<AlertAnnouncer alerts={[alert()]} decisions={new Map()} />);
    expect(live()).toBe("SpO2 low alert raised");

    rerender(<AlertAnnouncer alerts={[alert({ state: "ongoing" })]} decisions={new Map()} />);
    expect(live()).toBe("SpO2 low alert ongoing");

    rerender(
      <AlertAnnouncer
        alerts={[alert({ state: "resolved", resolvedAtMs: BASE_MS + 50_000 })]}
        decisions={new Map()}
      />,
    );
    expect(live()).toBe("SpO2 low alert resolved");
  });

  it("leaves a metric that reads fine as it is", () => {
    const { rerender } = render(<AlertAnnouncer alerts={[]} decisions={new Map()} />);
    rerender(
      <AlertAnnouncer
        alerts={[alert({ metric: "heartRateBpm", direction: "high" })]}
        decisions={new Map()}
      />,
    );
    expect(live()).toBe("heartRateBpm high alert raised");
  });

  it("announces a state once, not on every render that carries it", () => {
    const alerts = [alert()];
    const { rerender } = render(<AlertAnnouncer alerts={[]} decisions={new Map()} />);
    rerender(<AlertAnnouncer alerts={alerts} decisions={new Map()} />);
    expect(live()).toBe("SpO2 low alert raised");

    // Re-render with the same state, then change something else: if the
    // unchanged alert were re-announced it would ride along here.
    rerender(<AlertAnnouncer alerts={[...alerts]} decisions={new Map()} />);
    rerender(
      <AlertAnnouncer
        alerts={[alert(), alert({ alertId: "a2", metric: "heartRateBpm", direction: "high" })]}
        decisions={new Map()}
      />,
    );
    expect(live()).toBe("heartRateBpm high alert raised");
  });

  it("announces the feed dropping and coming back", () => {
    const { rerender } = render(
      <AlertAnnouncer alerts={[]} decisions={new Map()} connection="live" />,
    );
    expect(live()).toBe("");

    rerender(<AlertAnnouncer alerts={[]} decisions={new Map()} connection="reconnecting" />);
    expect(live()).toBe("Feed reconnecting");

    rerender(<AlertAnnouncer alerts={[]} decisions={new Map()} connection="live" />);
    expect(live()).toBe("Feed live");
  });

  it("announces a decision, and each one only once", () => {
    const alerts = [alert()];
    const { rerender } = render(<AlertAnnouncer alerts={alerts} decisions={new Map()} />);

    const decisions = new Map([["a1", decision()]]);
    rerender(<AlertAnnouncer alerts={alerts} decisions={decisions} />);
    expect(live()).toBe("SpO2 low alert acknowledged by night-shift");

    // The next announcement must carry the transition ALONE. If the decision
    // were announced again it would be appended to this string, so exact
    // equality is what makes the dedupe testable at all.
    rerender(
      <AlertAnnouncer alerts={[alert({ state: "ongoing" })]} decisions={new Map(decisions)} />,
    );
    expect(live()).toBe("SpO2 low alert ongoing");
  });

  it("still announces a decision whose alert has aged out of the window", () => {
    const { rerender } = render(<AlertAnnouncer alerts={[]} decisions={new Map()} />);
    rerender(
      <AlertAnnouncer alerts={[]} decisions={new Map([["gone", decision({ alertId: "gone" })]])} />,
    );
    expect(live()).toBe("An alert acknowledged by night-shift");
  });
});
