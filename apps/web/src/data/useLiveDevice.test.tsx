import type { AlertEvent } from "@maekbeat/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DeviceStreamHandlers, MaekbeatApi } from "../api/client";
import type { StoredFrame } from "../api/contracts";
import { ApiProvider } from "./api-context";
import { MAX_FRAMES, mergeAlerts, mergeFrames, useLiveDevice } from "./useLiveDevice";

const BASE_MS = 1_754_000_000_000;

function frame(seq: number, overrides: Partial<StoredFrame> = {}): StoredFrame {
  return {
    v: 1,
    deviceId: "dev-1",
    seq,
    capturedAtMs: BASE_MS + seq * 1_000,
    heartRateBpm: 70,
    spo2Pct: 97,
    respirationRpm: 14,
    motion: 0.1,
    receivedAtMs: BASE_MS + seq * 1_000 + 200,
    sessionEpoch: 1,
    ...overrides,
  };
}

const ALERT: AlertEvent = {
  alertId: "dev-1:spo2-low:1",
  deviceId: "dev-1",
  metric: "spo2Pct",
  direction: "low",
  state: "raised",
  raisedAtMs: BASE_MS + 40_000,
  windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
};

/** An API whose socket the test drives, and whose REST reads it counts. */
function fakeApi(initial: StoredFrame[]) {
  let handlers: DeviceStreamHandlers | undefined;
  const closed = { count: 0 };
  const restFrames = vi.fn(
    async (_deviceId: string, query?: { since?: number; limit?: number }) => {
      const frames = restFrames.nextFrames ?? initial;
      return {
        deviceId: "dev-1",
        count: frames.length,
        frames:
          query?.since === undefined
            ? frames
            : frames.filter((f) => f.capturedAtMs >= query.since!),
      };
    },
  ) as unknown as ReturnType<typeof vi.fn> & { nextFrames?: StoredFrame[] };
  const restAlerts = vi.fn(async () => ({
    deviceId: "dev-1",
    counters: { raised: 1, resolved: 0, suppressed: 2 },
    alerts: [] as AlertEvent[],
  }));

  const api: MaekbeatApi = {
    baseUrl: "http://api.test",
    health: async () => ({ status: "ok" as const, uptimeSec: 1, version: "0.0.0" }),
    listDevices: async () => ({
      ingest: {
        received: 0,
        accepted: 0,
        rejectedInvalid: 0,
        duplicatesDropped: 0,
        sessionsStarted: 0,
      },
      devices: [],
    }),
    readFrames: restFrames as unknown as MaekbeatApi["readFrames"],
    readAlerts: restAlerts as unknown as MaekbeatApi["readAlerts"],
    subscribe: (_deviceId, streamHandlers) => {
      handlers = streamHandlers;
      return {
        close: () => {
          closed.count += 1;
          handlers = undefined;
        },
      };
    },
  };

  return {
    api,
    closed,
    restFrames,
    restAlerts,
    handlers: () => handlers,
  };
}

function wrapper(api: MaekbeatApi) {
  return ({ children }: { children: ReactNode }) => <ApiProvider api={api}>{children}</ApiProvider>;
}

describe("mergeFrames", () => {
  it("dedupes on (sessionEpoch, seq) and keeps capture order", () => {
    const merged = mergeFrames([frame(2), frame(1)], [frame(1), frame(3)]);
    expect(merged.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("keeps a reboot's frames apart from the session they collide with", () => {
    const rebooted = frame(1, { sessionEpoch: 2, capturedAtMs: BASE_MS + 90_000 });
    const merged = mergeFrames([frame(1)], [rebooted]);
    expect(merged).toHaveLength(2);
  });

  it("holds a bounded window, dropping the oldest first", () => {
    const many = Array.from({ length: MAX_FRAMES + 50 }, (_, i) => frame(i));
    const merged = mergeFrames([], many);
    expect(merged).toHaveLength(MAX_FRAMES);
    expect(merged[0]?.seq).toBe(50);
  });

  it("returns the current window untouched when nothing arrived", () => {
    const current = [frame(1)];
    expect(mergeFrames(current, [])).toBe(current);
  });

  // A reboot may reset the device clock backwards. Ordering by capture time
  // alone would file the live session ahead of the old one, so a full window
  // would evict each new frame as it arrived and freeze on pre-reboot data.
  it("keeps a rebooted session's frames even when their clock runs backwards", () => {
    const full = Array.from({ length: MAX_FRAMES }, (_, i) => frame(i + 500));
    const rebooted = frame(0, { sessionEpoch: 2, capturedAtMs: BASE_MS });

    const merged = mergeFrames(full, [rebooted]);

    expect(merged).toHaveLength(MAX_FRAMES);
    expect(merged[merged.length - 1]).toEqual(rebooted);
  });
});

describe("mergeAlerts", () => {
  it("replaces an alert by id, so a transition updates rather than duplicates", () => {
    const merged = mergeAlerts([ALERT], [{ ...ALERT, state: "resolved", resolvedAtMs: BASE_MS }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.state).toBe("resolved");
  });

  it("orders by raise time and leaves an empty update alone", () => {
    const later = { ...ALERT, alertId: "b", raisedAtMs: ALERT.raisedAtMs + 1_000 };
    expect(mergeAlerts([later], [ALERT]).map((a) => a.alertId)).toEqual([ALERT.alertId, "b"]);
    const current = [ALERT];
    expect(mergeAlerts(current, [])).toBe(current);
  });
});

describe("useLiveDevice", () => {
  it("seeds from REST and then appends what the socket pushes", async () => {
    const fake = fakeApi([frame(1), frame(2)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => fake.handlers()?.onFrame(frame(3)));

    const state = result.current.state;
    expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(state.status === "ready" && state.data.counters.suppressed).toBe(2);
  });

  it("applies an alert transition pushed over the socket", async () => {
    const fake = fakeApi([frame(1)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => fake.handlers()?.onAlert(ALERT));
    act(() => fake.handlers()?.onAlert({ ...ALERT, state: "resolved", resolvedAtMs: BASE_MS + 1 }));

    const state = result.current.state;
    expect(state.status === "ready" && state.data.alerts).toHaveLength(1);
    expect(state.status === "ready" && state.data.alerts[0]?.state).toBe("resolved");
  });

  it("surfaces the connection state the transport reports", async () => {
    const fake = fakeApi([frame(1)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => fake.handlers()?.onState("reconnecting"));
    expect(result.current.connection).toBe("reconnecting");
    act(() => fake.handlers()?.onState("live"));
    expect(result.current.connection).toBe("live");
  });

  // The rule: a reconnect re-reads the window rather than resuming as if the
  // silence had been continuous.
  it("back-fills from REST on reconnect, asking only for what it is missing", async () => {
    const fake = fakeApi([frame(1), frame(2)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(fake.restFrames).toHaveBeenCalledTimes(1);

    // While the socket was down the server kept ingesting.
    fake.restFrames.nextFrames = [frame(1), frame(2), frame(3), frame(4)];
    await act(async () => {
      fake.handlers()?.onReconnect();
      await Promise.resolve();
    });

    await waitFor(() => {
      const state = result.current.state;
      expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    });
    expect(fake.restFrames).toHaveBeenCalledTimes(2);
    expect(fake.restFrames.mock.calls[1]?.[1]).toEqual({
      since: BASE_MS + 2_000,
      limit: 1_000,
    });
  });

  it("leaves the gap visible when the back-fill itself fails", async () => {
    const fake = fakeApi([frame(1)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    fake.restFrames.mockRejectedValueOnce(new Error("still down"));
    await act(async () => {
      fake.handlers()?.onReconnect();
      await Promise.resolve();
    });

    const state = result.current.state;
    expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([1]);
  });

  it("asks for the whole window when it has no frame to back-fill from", async () => {
    const fake = fakeApi([]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    fake.restFrames.nextFrames = [frame(1)];
    await act(async () => {
      fake.handlers()?.onReconnect();
      await Promise.resolve();
    });

    expect(fake.restFrames.mock.calls[1]?.[1]).toEqual({ limit: 1_000 });
    await waitFor(() => {
      const state = result.current.state;
      expect(state.status === "ready" && state.data.frames).toHaveLength(1);
    });
  });

  // The socket can push before the mount read resolves. Dropping that frame
  // would open a hole too small to cross the gap threshold, so it would be
  // drawn as continuous coverage — the exact lie the chart rules forbid.
  it("holds a pushed frame that arrives before the window exists", async () => {
    const fake = fakeApi([frame(1)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });

    act(() => fake.handlers()?.onFrame(frame(2)));
    act(() => fake.handlers()?.onAlert(ALERT));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    const state = result.current.state;
    expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(state.status === "ready" && state.data.alerts).toHaveLength(1);
  });

  // The empty state offers "Try again"; a retry that ran and still showed
  // nothing would be a lie about the read that just succeeded.
  it("fills the window when a reload finally returns frames", async () => {
    const fake = fakeApi([]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.status === "ready" && result.current.state.data.frames).toEqual([]);

    fake.restFrames.nextFrames = [frame(1), frame(2)];
    act(() => result.current.reload());

    await waitFor(() => {
      const state = result.current.state;
      expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([1, 2]);
    });
  });

  // One device's late back-fill must never be merged into another's window.
  it("abandons a back-fill when the device changes under it", async () => {
    const fake = fakeApi([frame(1)]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLiveDevice(id), {
      wrapper: wrapper(fake.api),
      initialProps: { id: "dev-1" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    // A back-fill for dev-1 that resolves only after the route moved to dev-2.
    let releaseBackfill: (() => void) | undefined;
    fake.restFrames.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBackfill = () =>
            resolve({ deviceId: "dev-1", count: 1, frames: [frame(99, { spo2Pct: 70 })] });
        }),
    );
    act(() => fake.handlers()?.onReconnect());

    fake.restFrames.nextFrames = [frame(5)];
    rerender({ id: "dev-2" });
    await waitFor(() => {
      const state = result.current.state;
      expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([5]);
    });

    await act(async () => {
      releaseBackfill?.();
      await Promise.resolve();
    });

    const state = result.current.state;
    expect(state.status === "ready" && state.data.frames.map((f) => f.seq)).toEqual([5]);
  });

  it("drops a back-fill that lands before the first read has seeded the window", async () => {
    const fake = fakeApi([frame(1)]);
    // The mount read never resolves, so there is no window to merge into.
    fake.restFrames.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });

    await act(async () => {
      fake.handlers()?.onReconnect();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("loading");
  });

  it("counts malformed messages instead of rendering them", async () => {
    const fake = fakeApi([frame(1)]);
    const { result } = renderHook(() => useLiveDevice("dev-1"), { wrapper: wrapper(fake.api) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => fake.handlers()?.onInvalidMessage?.());
    act(() => fake.handlers()?.onInvalidMessage?.());
    expect(result.current.malformed).toBe(2);
  });

  // No socket may outlive the screen that opened it.
  it("closes the socket on unmount", async () => {
    const fake = fakeApi([frame(1)]);
    const { result, unmount } = renderHook(() => useLiveDevice("dev-1"), {
      wrapper: wrapper(fake.api),
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    unmount();

    expect(fake.closed.count).toBe(1);
    expect(fake.handlers()).toBeUndefined();
  });

  it("closes the old socket when the device changes", async () => {
    const fake = fakeApi([frame(1)]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLiveDevice(id), {
      wrapper: wrapper(fake.api),
      initialProps: { id: "dev-1" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    rerender({ id: "dev-2" });

    expect(fake.closed.count).toBe(1);
  });
});
