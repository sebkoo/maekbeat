import type { AlertDecisionEvent, DeviceSilenceEvent } from "@maekbeat/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { DeviceStreamHandlers, MaekbeatApi } from "./api/client";
import { ApiError } from "./api/http";
import { ApiProvider } from "./data/api-context";

/*
 * The WCAG 2.2 AA pass (C12). Three things are checked here that a component
 * test would not catch: axe finds violations across the whole rendered page,
 * the acknowledgement flow is driven by keyboard alone, and the live region is
 * proven to be narrow — a streaming vitals chart must never announce itself.
 *
 * Colour contrast is gated separately and statically in src/styles/tokens.test.ts,
 * because jsdom has no layout and axe cannot evaluate contrast without it.
 */

const BASE_MS = 1_754_000_000_000;

const FRAMES = {
  deviceId: "sim-dev-1",
  count: 3,
  frames: [0, 1, 2].map((i) => ({
    v: 1 as const,
    deviceId: "sim-dev-1",
    seq: i,
    capturedAtMs: BASE_MS + i * 1_000,
    heartRateBpm: 70 + i,
    spo2Pct: 97 - i,
    respirationRpm: 14,
    motion: 0.1,
    receivedAtMs: BASE_MS + i * 1_000 + 200,
    sessionEpoch: 1,
  })),
};

const ALERT = {
  alertId: "sim-dev-1:spo2-low:1",
  deviceId: "sim-dev-1",
  metric: "spo2Pct" as const,
  direction: "low" as const,
  state: "raised" as const,
  raisedAtMs: BASE_MS + 1_000,
  windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
};

const ALERTS = {
  deviceId: "sim-dev-1",
  counters: { raised: 1, resolved: 0, suppressed: 0, acknowledged: 0, dismissed: 0 },
  alerts: [ALERT],
  decisions: [] as AlertDecisionEvent[],
  silence: [] as DeviceSilenceEvent[],
};

let streamHandlers: DeviceStreamHandlers | undefined;

function fakeApi(overrides: Partial<MaekbeatApi> = {}): MaekbeatApi {
  return {
    baseUrl: "http://api.test",
    health: async () => ({ status: "ok" as const, uptimeSec: 1, version: "0.0.0" }),
    listDevices: async () => ({
      ingest: {
        received: 3,
        accepted: 3,
        rejectedInvalid: 0,
        duplicatesDropped: 0,
        sessionsStarted: 1,
      },
      devices: [
        {
          deviceId: "sim-dev-1",
          sessionEpoch: 1,
          frameCount: 3,
          lastSeq: 2,
          lastReceivedAtMs: BASE_MS + 2_200,
          duplicatesDropped: 0,
        },
      ],
    }),
    readFrames: async () => FRAMES,
    readAlerts: async () => ALERTS,
    recordDecision: async (deviceId, alertId, decision) => ({
      eventId: `${deviceId}:decision:1`,
      alertId,
      deviceId,
      decision,
      actor: "web-dashboard",
      recordedAtMs: BASE_MS + 30_000,
    }),
    subscribe: (_deviceId, handlers) => {
      streamHandlers = handlers;
      handlers.onState("live");
      return { close: () => (streamHandlers = undefined) };
    },
    ...overrides,
  };
}

function renderApp(api: MaekbeatApi, route: string) {
  return render(
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </ApiProvider>,
  );
}

/** axe over the rendered page; contrast is excluded because jsdom has no layout. */
async function auditViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

describe("axe", () => {
  it("finds no violations on the device list", async () => {
    const { container } = renderApp(fakeApi(), "/");
    await screen.findByRole("link", { name: "sim-dev-1" });

    expect(await auditViolations(container)).toEqual([]);
  });

  it("finds no violations on the device page, alerts and all", async () => {
    const { container } = renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    expect(await auditViolations(container)).toEqual([]);
  });

  it("finds no violations once a decision has been recorded", async () => {
    const { container } = renderApp(fakeApi(), "/devices/sim-dev-1");
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));
    await screen.findByText(/Acknowledged by web-dashboard/);

    expect(await auditViolations(container)).toEqual([]);
  });
});

describe("keyboard operability", () => {
  // Every acknowledgement control must be reachable and operable without a
  // pointer: WCAG 2.2 SC 2.1.1, and the only way a caregiver on a keyboard or
  // a switch device can clear an alert at all.
  it("acknowledges an alert with the keyboard alone", async () => {
    const recordDecision = vi.fn(async () => ({
      eventId: "sim-dev-1:decision:1",
      alertId: ALERT.alertId,
      deviceId: "sim-dev-1",
      decision: "acknowledged" as const,
      actor: "web-dashboard",
      recordedAtMs: BASE_MS + 30_000,
    }));
    renderApp(fakeApi({ recordDecision }), "/devices/sim-dev-1");

    const user = userEvent.setup();
    const acknowledge = await screen.findByRole("button", { name: /Acknowledge/ });

    // Tab to it and press Enter. user-event synthesises the browser's own
    // key-to-activation path and honours preventDefault, so a control that
    // only responds to a mouse — or one that kills the key default — fails
    // here. The test never fires the click itself.
    await user.tab();
    while (document.activeElement !== acknowledge) await user.tab();
    await user.keyboard("{Enter}");

    await screen.findByText(/Acknowledged by web-dashboard/);
    expect(recordDecision).toHaveBeenCalledWith("sim-dev-1", ALERT.alertId, "acknowledged");
  });

  it("keeps both controls in the tab order and none of them disabled at rest", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("tabindex")).toBeNull();
      expect(button).toHaveProperty("disabled", false);
    }
  });
});

describe("live regions", () => {
  // A 1 Hz chart inside a live region would interrupt a screen-reader user
  // roughly once a second with a number they did not ask for. The numbers stay
  // silent; the summary is available on demand through the chart's own label.
  // role="status" and role="alert" ARE live regions with no aria-live
  // attribute, so detecting only the attribute would miss a chart wrapped in
  // either — which is the failure this suite exists to prevent.
  const LIVE_SELECTOR =
    '[aria-live],[role="alert"],[role="status"],[role="log"],[role="timer"],[role="marquee"],output';

  it("never puts the streaming chart inside a live region", async () => {
    const { container } = renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    const charts = screen.getAllByRole("img");
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      expect(chart.getAttribute("aria-label")).toBeTruthy();
      for (let node: Element | null = chart; node !== null; node = node.parentElement) {
        expect(node.matches(LIVE_SELECTOR), `${node.nodeName} is a live region`).toBe(false);
        if (node === container) break;
      }
    }
  });

  it("carries one polite announcer at rest, and nothing else that speaks", async () => {
    const { container } = renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    const live = [...container.querySelectorAll(LIVE_SELECTOR)];
    expect(live).toHaveLength(1);
    expect(live[0]?.getAttribute("aria-live")).toBe("polite");
    // It starts empty: the backlog on arrival is not news.
    expect(live[0]?.textContent).toBe("");
  });

  // The one deliberate exception, and it is assertive on purpose: a decision
  // the server refused is a failed action the user must know about now.
  it("adds exactly one assertive region when a decision is refused", async () => {
    const { container } = renderApp(
      fakeApi({
        recordDecision: async () => {
          throw new ApiError("http", "unknown alert: stale on sim-dev-1", { status: 404 });
        },
      }),
      "/devices/sim-dev-1",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));
    await screen.findByText(/Not recorded:/);

    const live = [...container.querySelectorAll(LIVE_SELECTOR)];
    expect(live).toHaveLength(2);
    expect(live.filter((node) => node.getAttribute("role") === "alert")).toHaveLength(1);
  });

  it("announces an alert transition, and stays silent for streaming frames", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    const live = document.querySelector("[aria-live]");

    // Twenty frames arrive. They are flushed inside act() and the silence is
    // asserted synchronously afterwards: a waitFor here would resolve on a
    // condition that is already true and could never observe an announcement
    // landing one microtask later.
    await act(async () => {
      for (let i = 3; i < 23; i++) {
        streamHandlers?.onFrame({
          ...FRAMES.frames[0]!,
          seq: i,
          capturedAtMs: BASE_MS + i * 1_000,
        });
      }
    });
    expect(live?.textContent).toBe("");

    // The alert resolving is exactly what it should announce.
    streamHandlers?.onAlert({ ...ALERT, state: "resolved", resolvedAtMs: BASE_MS + 40_000 });
    await waitFor(() => expect(live?.textContent).toContain("SpO2 low alert resolved"));
  });

  it("announces a decision once it is recorded", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));

    const live = document.querySelector("[aria-live]");
    await waitFor(() => expect(live?.textContent).toContain("acknowledged by web-dashboard"));
  });
});

describe("a refused decision", () => {
  // The failure path that matters: a rejected acknowledgement must not leave a
  // checkmark claiming an audit-log entry that does not exist.
  it("leaves no decision behind when the server refuses it", async () => {
    renderApp(
      fakeApi({
        recordDecision: async () => {
          throw new ApiError("http", "unknown alert: stale on sim-dev-1", { status: 404 });
        },
      }),
      "/devices/sim-dev-1",
    );

    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));

    await screen.findByText(/Not recorded: unknown alert/);
    expect(screen.queryByText(/Acknowledged by/)).toBeNull();
    // The control comes back, so the alert can still be judged.
    expect(await screen.findByRole("button", { name: /Acknowledge/ })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
