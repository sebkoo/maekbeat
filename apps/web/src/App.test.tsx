import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { AlertDecisionEvent, DeviceSilenceEvent } from "@maekbeat/protocol";

import { App } from "./App";
import type { DeviceStreamHandlers, MaekbeatApi } from "./api/client";
import { ApiError } from "./api/http";
import { AppShell } from "./components/AppShell";
import { ApiProvider, useApi } from "./data/api-context";

const DEVICE = {
  deviceId: "sim-dev-1",
  sessionEpoch: 1,
  frameCount: 130,
  lastSeq: 129,
  lastReceivedAtMs: 1_754_000_012_500,
  duplicatesDropped: 2,
};

const DEVICE_LIST = {
  ingest: {
    received: 133,
    accepted: 130,
    rejectedInvalid: 1,
    duplicatesDropped: 2,
    sessionsStarted: 1,
  },
  devices: [DEVICE],
};

const FRAMES = {
  deviceId: "sim-dev-1",
  count: 2,
  frames: [
    {
      v: 1 as const,
      deviceId: "sim-dev-1",
      seq: 128,
      capturedAtMs: 1_754_000_011_000,
      heartRateBpm: 70,
      spo2Pct: 98,
      respirationRpm: 13.8,
      motion: 0.08,
      receivedAtMs: 1_754_000_011_240,
      sessionEpoch: 1,
    },
    {
      v: 1 as const,
      deviceId: "sim-dev-1",
      seq: 129,
      capturedAtMs: 1_754_000_012_000,
      heartRateBpm: 72,
      spo2Pct: 97.5,
      respirationRpm: 14.2,
      motion: 0.12,
      receivedAtMs: 1_754_000_012_500,
      sessionEpoch: 1,
    },
  ],
};

const windowStats = {
  windowMs: 15_000,
  sampleCount: 15,
  breachCount: 5,
  minValue: 86,
  maxValue: 94,
};

const ALERTS = {
  deviceId: "sim-dev-1",
  counters: { raised: 2, resolved: 1, suppressed: 0, acknowledged: 0, dismissed: 0 },
  decisions: [] as AlertDecisionEvent[],
  silence: [] as DeviceSilenceEvent[],
  alerts: [
    {
      alertId: "sim-dev-1:spo2-low:1",
      deviceId: "sim-dev-1",
      metric: "spo2Pct" as const,
      direction: "low" as const,
      state: "resolved" as const,
      raisedAtMs: 1_754_000_040_000,
      resolvedAtMs: 1_754_000_093_000,
      windowStats,
    },
    {
      alertId: "sim-dev-1:hr-high:1",
      deviceId: "sim-dev-1",
      metric: "heartRateBpm" as const,
      direction: "high" as const,
      state: "ongoing" as const,
      raisedAtMs: 1_754_000_100_000,
      windowStats,
    },
    {
      alertId: "sim-dev-1:hr-low:1",
      deviceId: "sim-dev-1",
      metric: "heartRateBpm" as const,
      direction: "low" as const,
      state: "raised" as const,
      raisedAtMs: 1_754_000_120_000,
      windowStats,
    },
  ],
};

/** Handlers of the most recent subscription, so a test can push frames. */
let streamHandlers: DeviceStreamHandlers | undefined;
let openSockets = 0;

/** A client that answers from fixtures; overrides replace one route at a time. */
function fakeApi(overrides: Partial<MaekbeatApi> = {}): MaekbeatApi {
  return {
    baseUrl: "http://api.test",
    health: async () => ({ status: "ok" as const, uptimeSec: 1, version: "0.0.0" }),
    listDevices: async () => DEVICE_LIST,
    readFrames: async () => FRAMES,
    readAlerts: async () => ALERTS,
    recordDecision: async (deviceId, alertId, decision) => ({
      eventId: `${deviceId}:decision:1`,
      alertId,
      deviceId,
      decision,
      actor: "web-dashboard",
      recordedAtMs: 1_754_000_200_000,
    }),
    subscribe: (_deviceId, handlers) => {
      streamHandlers = handlers;
      openSockets += 1;
      // A fake socket that opens immediately, as the real transport reports.
      handlers.onState("live");
      return {
        close: () => {
          openSockets -= 1;
          streamHandlers = undefined;
        },
      };
    },
    ...overrides,
  };
}

function renderApp(api: MaekbeatApi, route = "/") {
  return render(
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </ApiProvider>,
  );
}

describe("app shell", () => {
  it("renders the device list, with the not-a-medical-device line in the interface itself", async () => {
    renderApp(fakeApi());

    screen.getByText("Maekbeat");
    const disclaimer = screen.getByText(/Not a medical device/i);
    expect(disclaimer.textContent).toContain("Synthetic data only");
    expect(screen.getByRole("link", { name: "Read the disclaimer" }).getAttribute("href")).toBe(
      "https://github.com/sebkoo/maekbeat/blob/main/DISCLAIMER.md",
    );

    await screen.findByRole("link", { name: "sim-dev-1" });
    screen.getByText(/130 accepted/);
    // The page owns the only h1; the brand in the shell is not a heading.
    expect(screen.getAllByRole("heading", { level: 1 }).map((node) => node.textContent)).toEqual([
      "Devices",
    ]);
  });

  it("answers an unknown route instead of rendering a blank screen", () => {
    renderApp(fakeApi(), "/nowhere");
    screen.getByRole("heading", { level: 1, name: "No such page" });
  });

  it("refuses to build a component outside the API provider", () => {
    function Bare() {
      useApi();
      return null;
    }
    const noise = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/ApiProvider/);
    noise.mockRestore();
  });

  // A thrown route must not take the disclaimer down with it: a blank screen
  // is indistinguishable from a calm one.
  it("keeps the shell and the disclaimer up when a route throws, and recovers on retry", () => {
    let explode = true;
    function Boom() {
      if (explode) throw new Error("render exploded");
      return <p>recovered</p>;
    }
    const noise = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MemoryRouter>
        <AppShell>
          <Boom />
        </AppShell>
      </MemoryRouter>,
    );

    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("This screen failed to render");
    expect(panel.textContent).toContain("render exploded");
    screen.getByText(/Not a medical device/i);

    explode = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    screen.getByText("recovered");
    noise.mockRestore();
  });

  it("gives a thrown value that is not an Error a message anyway", () => {
    function BadThrow(): never {
      // eslint has no say here; libraries do throw strings.
      throw "socket refused";
    }
    const noise = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MemoryRouter>
        <AppShell>
          <BadThrow />
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert").textContent).toContain("socket refused");
    noise.mockRestore();
  });
});

describe("read states", () => {
  it("says it is loading while the read is in flight", () => {
    renderApp(fakeApi({ listDevices: () => new Promise(() => {}) }));

    const panel = screen.getByRole("status");
    expect(panel.textContent).toContain("Reading devices");
    expect(panel.getAttribute("aria-busy")).toBe("true");
  });

  it("says there is no data yet rather than showing an empty table", async () => {
    renderApp(fakeApi({ listDevices: async () => ({ ...DEVICE_LIST, devices: [] }) }));

    await screen.findByRole("heading", { name: "No data yet" });
    screen.getByText(/pnpm --filter @maekbeat\/server demo/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("calls an unreachable server a lost connection, not a bug", async () => {
    renderApp(
      fakeApi({
        listDevices: async () => {
          throw new ApiError("network", "cannot reach the Maekbeat API at http://api.test/devices");
        },
      }),
    );

    const panel = await screen.findByRole("alert");
    expect(panel.textContent).toContain("Connection lost");
    expect(panel.textContent).toContain("cannot reach the Maekbeat API");
  });

  it("surfaces a server-side failure and retries the read on demand", async () => {
    const listDevices = vi
      .fn<MaekbeatApi["listDevices"]>()
      .mockRejectedValueOnce(new ApiError("http", "unknown device: nope", { status: 404 }))
      .mockResolvedValueOnce(DEVICE_LIST);
    renderApp(fakeApi({ listDevices }));

    expect((await screen.findByRole("alert")).textContent).toContain("This read failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("link", { name: "sim-dev-1" });
    expect(listDevices).toHaveBeenCalledTimes(2);
  });
});

describe("device detail", () => {
  it("shows the latest frame, the alert lifecycle, and the two charts", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");

    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    const metrics = [...document.querySelectorAll(".mb-metric__value")].map(
      (node) => node.textContent,
    );
    expect(metrics).toEqual(["72bpm", "97.5%", "14.2rpm", "0.120–1"]);

    // Server receive time minus device capture time — the drift signal.
    screen.getByText(/clock delta \+500 ms/);
    screen.getByText(/Captured 2025-07-31 22:13:32Z/);

    // Newest episode first: a caregiver reads the top of the timeline.
    const badges = [...document.querySelectorAll(".mb-alert-badge")];
    expect(badges.map((node) => node.getAttribute("data-alert-state"))).toEqual([
      "raised",
      "ongoing",
      "resolved",
    ]);
    expect(badges.map((node) => node.textContent)).toEqual(["raised", "ongoing", "resolved"]);

    // Small multiples, not a dual axis: one chart per metric, same time axis.
    const charts = screen.getAllByRole("img").map((node) => node.getAttribute("aria-label"));
    expect(charts).toHaveLength(2);
    expect(charts[0]).toContain("SpO2 in %");
    expect(charts[1]).toContain("Heart rate in bpm");
  });

  it("appends what the socket pushes without a re-read", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    expect(screen.getByText("live")).toBeDefined();

    act(() =>
      streamHandlers?.onFrame({
        ...FRAMES.frames[1]!,
        seq: 130,
        capturedAtMs: FRAMES.frames[1]!.capturedAtMs + 1_000,
        receivedAtMs: FRAMES.frames[1]!.receivedAtMs + 1_000,
        heartRateBpm: 81,
      }),
    );

    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".mb-metric__value")].map((node) => node.textContent)[0],
      ).toBe("81bpm"),
    );
  });

  it("shows the connection state next to the data it explains", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    act(() => streamHandlers?.onState("reconnecting"));
    expect(document.querySelector(".mb-conn-badge")?.textContent).toBe("reconnecting");

    act(() => streamHandlers?.onState("disconnected"));
    const badge = document.querySelector(".mb-conn-badge");
    expect(badge?.textContent).toBe("disconnected");
    // The word is the cue; the palette repeats it, never replaces it.
    expect(badge?.getAttribute("data-alert-state")).toBe("raised");
  });

  // Alarm fatigue is the design constraint (C21): a 30-tick anomaly must read
  // as one episode with a duration, not as thirty entries in a list.
  it("shows a whole alert lifecycle as one timeline row", async () => {
    renderApp(
      fakeApi({
        readAlerts: async () => ({ ...ALERTS, alerts: [], decisions: [], silence: [] }),
      }),
      "/devices/sim-dev-1",
    );
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    const episode = {
      alertId: "sim-dev-1:spo2-low:7",
      deviceId: "sim-dev-1",
      metric: "spo2Pct" as const,
      direction: "low" as const,
      raisedAtMs: 1_754_000_010_000,
      windowStats,
    };
    // The same episode arriving three times, as the engine reports it.
    act(() => streamHandlers?.onAlert({ ...episode, state: "raised" }));
    act(() => streamHandlers?.onAlert({ ...episode, state: "ongoing" }));
    act(() =>
      streamHandlers?.onAlert({
        ...episode,
        state: "resolved",
        resolvedAtMs: episode.raisedAtMs + 53_000,
      }),
    );

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    const row = screen.getAllByRole("listitem")[0]!;
    expect(row.getAttribute("data-alert-state")).toBe("resolved");
    expect(row.textContent).toContain("53s");
  });

  it("admits to dropping messages the contract rejected", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });

    act(() => streamHandlers?.onInvalidMessage?.());
    await screen.findByText(/1 malformed message dropped/);

    act(() => streamHandlers?.onInvalidMessage?.());
    await screen.findByText(/2 malformed messages dropped/);
  });

  // Names what it checks: the route closes its subscription. That the
  // transport then leaves no socket or timer behind is stream.test.ts's job.
  it("closes its subscription when the route unmounts", async () => {
    openSockets = 0;
    const { unmount } = renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    expect(openSockets).toBe(1);

    unmount();
    expect(openSockets).toBe(0);
  });

  it("reports a device the server does not know", async () => {
    renderApp(
      fakeApi({
        readFrames: async () => {
          throw new ApiError("http", "unknown device: ghost", { status: 404 });
        },
      }),
      "/devices/ghost",
    );

    expect((await screen.findByRole("alert")).textContent).toContain("unknown device: ghost");
  });

  it("says the window is empty rather than rendering a frame that is not there", async () => {
    renderApp(
      fakeApi({ readFrames: async () => ({ deviceId: "sim-dev-1", count: 0, frames: [] }) }),
      "/devices/sim-dev-1",
    );

    await screen.findByRole("heading", { name: "No data yet" });
  });

  it("says so when a device has no alerts, instead of an empty list", async () => {
    renderApp(
      fakeApi({
        readAlerts: async () => ({
          deviceId: "sim-dev-1",
          counters: { raised: 0, resolved: 0, suppressed: 0, acknowledged: 0, dismissed: 0 },
          alerts: [],
          decisions: [],
          silence: [],
        }),
      }),
      "/devices/sim-dev-1",
    );

    await screen.findByText("No alerts recorded for this device.");
  });

  it("navigates from the list to one device", async () => {
    renderApp(fakeApi());

    fireEvent.click(await screen.findByRole("link", { name: "sim-dev-1" }));
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    screen.getByText(/Live over the fan-out socket/);
  });
});

describe("styles are applied, not merely defined", () => {
  it("renders every class app.css styles", async () => {
    const appCss = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");
    const styled = new Set(
      [...appCss.matchAll(/\.(mb-[a-z0-9_-]+)/g)].map(([, name]) => name as string),
    );

    const rendered = new Set<string>();
    const collect = () => {
      for (const node of document.querySelectorAll<HTMLElement>("[class]")) {
        for (const name of node.classList) rendered.add(name);
      }
    };

    // Every designed state, so a class that only appears in a failure path is
    // still covered: list, empty, loading, error, detail, unknown route.
    renderApp(fakeApi());
    await screen.findByRole("link", { name: "sim-dev-1" });
    collect();
    cleanup();

    renderApp(fakeApi({ listDevices: async () => ({ ...DEVICE_LIST, devices: [] }) }));
    await screen.findByRole("heading", { name: "No data yet" });
    collect();
    cleanup();

    renderApp(fakeApi({ listDevices: () => new Promise(() => {}) }));
    collect();
    cleanup();

    renderApp(
      fakeApi({
        listDevices: async () => {
          throw new ApiError("http", "boom", { status: 500 });
        },
      }),
    );
    await screen.findByRole("alert");
    collect();
    cleanup();

    renderApp(
      fakeApi({
        listDevices: async () => {
          throw new ApiError("network", "server unreachable");
        },
      }),
    );
    await screen.findByRole("alert");
    collect();
    cleanup();

    renderApp(fakeApi(), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    collect();
    cleanup();

    // A window with a hole in it, so the gap band is among the classes checked.
    // The threshold is derived from the median interval, so the series needs
    // enough 1 Hz samples for a 40 s hole to stand out as one.
    const run = (count: number, seq0: number, startMs: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...FRAMES.frames[1]!,
        seq: seq0 + i,
        capturedAtMs: startMs + i * 1_000,
        receivedAtMs: startMs + i * 1_000 + 500,
      }));
    const firstRun = run(20, 200, FRAMES.frames[1]!.capturedAtMs);
    const gappedFrames = [...firstRun, ...run(10, 300, firstRun[19]!.capturedAtMs + 40_000)];
    const gapped = { ...FRAMES, count: gappedFrames.length, frames: gappedFrames };
    renderApp(fakeApi({ readFrames: async () => gapped }), "/devices/sim-dev-1");
    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    collect();
    cleanup();

    // A decision already in force, so the recorded line is among the classes.
    renderApp(
      fakeApi({
        readAlerts: async () => ({
          ...ALERTS,
          decisions: [
            {
              eventId: "sim-dev-1:decision:1",
              alertId: ALERTS.alerts[0]!.alertId,
              deviceId: "sim-dev-1",
              decision: "acknowledged" as const,
              actor: "web-dashboard",
              recordedAtMs: 1_754_000_200_000,
            },
          ],
        }),
      }),
      "/devices/sim-dev-1",
    );
    await screen.findByText(/Acknowledged by web-dashboard/);
    collect();
    cleanup();

    // A decision whose alert the server no longer retains, so the orphan row
    // is among the classes checked.
    renderApp(
      fakeApi({
        readAlerts: async () => ({
          ...ALERTS,
          alerts: [],
          decisions: [
            {
              eventId: "sim-dev-1:decision:9",
              alertId: "sim-dev-1:spo2-low:1754000000000:1",
              deviceId: "sim-dev-1",
              decision: "dismissed" as const,
              actor: "night-shift",
              recordedAtMs: 1_754_000_300_000,
            },
          ],
        }),
      }),
      "/devices/sim-dev-1",
    );
    await screen.findByText("Decided, alert no longer retained");
    collect();
    cleanup();

    // And a decision the server refused, so the failure line is covered too.
    renderApp(
      fakeApi({
        recordDecision: async () => {
          throw new ApiError("http", "unknown alert: ghost on sim-dev-1", { status: 404 });
        },
      }),
      "/devices/sim-dev-1",
    );
    const ackButton = await screen.findAllByRole("button", { name: /Acknowledge/ });
    fireEvent.click(ackButton[0]!);
    await screen.findByText(/Not recorded:/);
    collect();

    await waitFor(() => {
      // Both directions: a styled class nothing renders is dead CSS, and a
      // rendered class nothing styles is a state that silently looks like
      // every other one.
      expect([...styled].filter((name) => !rendered.has(name))).toEqual([]);
      expect([...rendered].filter((name) => name.startsWith("mb-") && !styled.has(name))).toEqual(
        [],
      );
    });
  });
});
