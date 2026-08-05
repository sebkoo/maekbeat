import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { MaekbeatApi } from "./api/client";
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
  counters: { raised: 2, resolved: 1, suppressed: 0 },
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

/** A client that answers from fixtures; overrides replace one route at a time. */
function fakeApi(overrides: Partial<MaekbeatApi> = {}): MaekbeatApi {
  return {
    baseUrl: "http://api.test",
    health: async () => ({ status: "ok" as const, uptimeSec: 1, version: "0.0.0" }),
    listDevices: async () => DEVICE_LIST,
    readFrames: async () => FRAMES,
    readAlerts: async () => ALERTS,
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
  it("shows the latest frame, the alert lifecycle, and an honest chart placeholder", async () => {
    renderApp(fakeApi(), "/devices/sim-dev-1");

    await screen.findByRole("heading", { level: 1, name: "sim-dev-1" });
    const metrics = [...document.querySelectorAll(".mb-metric__value")].map(
      (node) => node.textContent,
    );
    expect(metrics).toEqual(["72bpm", "97.5%", "14.2rpm", "0.120–1"]);

    // Server receive time minus device capture time — the drift signal.
    screen.getByText(/clock delta \+500 ms/);
    screen.getByText(/Captured 2025-07-31 22:13:32Z/);

    const badges = [...document.querySelectorAll(".mb-alert-badge")];
    expect(badges.map((node) => node.getAttribute("data-alert-state"))).toEqual([
      "resolved",
      "ongoing",
      "raised",
    ]);
    expect(badges.map((node) => node.textContent)).toEqual(["resolved", "ongoing", "raised"]);

    screen.getByText(/The live chart lands at C11/);
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
          counters: { raised: 0, resolved: 0, suppressed: 0 },
          alerts: [],
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
    screen.getByText(/Latest of 2 frames/);
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
