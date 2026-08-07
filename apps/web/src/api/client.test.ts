import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApiClient,
  ingestUrl,
  resolveApiBaseUrl,
  streamUrl,
  DEFAULT_API_BASE_URL,
} from "./client";
import { ApiError, type FetchLike } from "./http";
import type { SocketHandlers } from "./stream";

const BASE = "http://api.test";

const FRAME = {
  v: 1,
  deviceId: "dev-1",
  seq: 7,
  capturedAtMs: 1_754_000_000_000,
  heartRateBpm: 72,
  spo2Pct: 97.5,
  respirationRpm: 14.2,
  motion: 0.12,
  receivedAtMs: 1_754_000_000_310,
  sessionEpoch: 1,
};

const ALERT = {
  alertId: "dev-1:spo2-low:1",
  deviceId: "dev-1",
  metric: "spo2Pct",
  direction: "low",
  state: "resolved",
  raisedAtMs: 1_754_000_040_000,
  resolvedAtMs: 1_754_000_093_000,
  windowStats: { windowMs: 15_000, sampleCount: 15, breachCount: 5, minValue: 86, maxValue: 94 },
};

const SILENCE = {
  alertId: "dev-1:device-silent:1754000200000:1",
  deviceId: "dev-1",
  kind: "silence",
  state: "resolved",
  raisedAtMs: 1_754_000_200_000,
  resolvedAtMs: 1_754_000_260_000,
  lastFrameAtMs: 1_754_000_154_000,
  thresholdMs: 45_000,
  silentForMs: 106_000,
  sessionEpoch: 1,
};

const DECISION = {
  eventId: "dev-1:decision:1",
  alertId: "dev-1:spo2-low:1",
  deviceId: "dev-1",
  decision: "acknowledged",
  actor: "web-dashboard",
  recordedAtMs: 1_754_000_120_000,
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Records every URL the client asks for and answers with a canned body. */
function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input);
    return response(body, status);
  };
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient — happy path", () => {
  it("reads /healthz", async () => {
    const { calls, fetchImpl } = stubFetch({ status: "ok", uptimeSec: 12.5, version: "0.0.0" });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    await expect(api.health()).resolves.toEqual({
      status: "ok",
      uptimeSec: 12.5,
      version: "0.0.0",
    });
    expect(calls).toEqual([`${BASE}/healthz`]);
  });

  it("reads /devices with its ingest counters", async () => {
    const { calls, fetchImpl } = stubFetch({
      ingest: {
        received: 10,
        accepted: 9,
        rejectedInvalid: 1,
        duplicatesDropped: 0,
        sessionsStarted: 1,
      },
      devices: [
        {
          deviceId: "dev-1",
          sessionEpoch: 1,
          frameCount: 9,
          lastSeq: 8,
          lastReceivedAtMs: 1_754_000_000_310,
          duplicatesDropped: 0,
        },
      ],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const list = await api.listDevices();
    expect(list.devices[0]?.deviceId).toBe("dev-1");
    expect(list.ingest.accepted).toBe(9);
    expect(calls).toEqual([`${BASE}/devices`]);
  });

  it("reads frames and validates them with the shared @maekbeat/protocol schema", async () => {
    const { calls, fetchImpl } = stubFetch({ deviceId: "dev-1", count: 1, frames: [FRAME] });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const page = await api.readFrames("dev-1");
    expect(page.frames[0]?.heartRateBpm).toBe(72);
    expect(calls).toEqual([`${BASE}/devices/dev-1/frames`]);
  });

  it("serialises since and limit, and percent-encodes the device id", async () => {
    const { calls, fetchImpl } = stubFetch({ deviceId: "a/b", count: 0, frames: [] });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    await api.readFrames("a/b", { since: 1_754_000_000_000, limit: 50 });
    expect(calls).toEqual([`${BASE}/devices/a%2Fb/frames?since=1754000000000&limit=50`]);
  });

  it("reads alerts, counters included", async () => {
    const { calls, fetchImpl } = stubFetch({
      deviceId: "dev-1",
      counters: { raised: 1, resolved: 1, suppressed: 0, acknowledged: 1, dismissed: 0 },
      alerts: [ALERT],
      decisions: [DECISION],
      silence: [SILENCE],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const page = await api.readAlerts("dev-1");
    expect(page.alerts[0]?.state).toBe("resolved");
    expect(page.counters.raised).toBe(1);
    expect(page.decisions).toEqual([DECISION]);
    // Silence episodes come back as their own list, not folded into `alerts`:
    // the dashboard must be able to tell "a value crossed a line" from
    // "nothing arrived at all" without inspecting a field (C20a).
    expect(page.silence).toEqual([SILENCE]);
    expect(page.alerts).toHaveLength(1);
    expect(calls).toEqual([`${BASE}/devices/dev-1/alerts`]);
  });

  it("trims a trailing slash off the base URL instead of doubling it", async () => {
    const { calls, fetchImpl } = stubFetch({ status: "ok", uptimeSec: 1, version: "0.0.0" });
    const api = createApiClient({ baseUrl: `${BASE}/`, fetchImpl });

    await api.health();
    expect(api.baseUrl).toBe(BASE);
    expect(calls).toEqual([`${BASE}/healthz`]);
  });

  it("falls back to the platform fetch when none is injected", async () => {
    const platformFetch = vi.fn(async () =>
      response({ status: "ok", uptimeSec: 1, version: "0.0.0" }),
    );
    vi.stubGlobal("fetch", platformFetch);

    await createApiClient({ baseUrl: BASE }).health();
    expect(platformFetch).toHaveBeenCalledOnce();
  });
});

describe("createApiClient — failure handling", () => {
  it("reports an unreachable server as a network error, not a bug", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = await api.listDevices().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("network");
    expect((error as ApiError).message).toContain(`${BASE}/devices`);
  });

  it("rethrows an abort untouched — a left screen is not a failed read", async () => {
    const fetchImpl: FetchLike = async () => {
      const abort = new Error("The operation was aborted.");
      abort.name = "AbortError";
      throw abort;
    };
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = await api.health().catch((cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("carries the server's 404 message through", async () => {
    const { fetchImpl } = stubFetch({ statusCode: 404, message: "unknown device: nope" }, 404);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.readAlerts("nope").catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("http");
    expect(error.status).toBe(404);
    expect(error.message).toBe("unknown device: nope");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      ({
        ok: false,
        status: 502,
        json: async () => ({}),
        text: async () => "<html>bad gateway</html>",
      }) as unknown as Response;
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.health().catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("http");
    expect(error.message).toBe("request failed with status 502");
  });

  it("reports a body that is not JSON as a contract error", async () => {
    const fetchImpl: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
        text: async () => "<html>",
      }) as unknown as Response;
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.health().catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
    expect(error.message).toContain("did not return JSON");
  });

  it("names the root when the whole body is the wrong shape", async () => {
    const { fetchImpl } = stubFetch(null);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.health().catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
    expect(error.message).toContain("(root)");
  });

  it("rejects a frame that violates the protocol bounds, naming the field", async () => {
    const { fetchImpl } = stubFetch({
      deviceId: "dev-1",
      count: 1,
      frames: [{ ...FRAME, spo2Pct: 140 }],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.readFrames("dev-1").catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
    expect(error.message).toContain("frames.0.spo2Pct");
  });

  it("rejects an unknown key inside a frame — the wire contract stays strict", async () => {
    const { fetchImpl } = stubFetch({
      deviceId: "dev-1",
      count: 1,
      frames: [{ ...FRAME, bloodPressure: 120 }],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.readFrames("dev-1").catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
  });

  it("rejects an alert whose resolve precedes its raise", async () => {
    const { fetchImpl } = stubFetch({
      deviceId: "dev-1",
      counters: { raised: 1, resolved: 1, suppressed: 0 },
      alerts: [{ ...ALERT, resolvedAtMs: ALERT.raisedAtMs - 1 }],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api.readAlerts("dev-1").catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
  });

  it("accepts an added envelope field — additive server changes must not blank the screen", async () => {
    const { fetchImpl } = stubFetch({
      ingest: {
        received: 1,
        accepted: 1,
        rejectedInvalid: 0,
        duplicatesDropped: 0,
        sessionsStarted: 1,
        framesArchived: 1,
      },
      devices: [],
    });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    await expect(api.listDevices()).resolves.toMatchObject({ devices: [] });
  });
});

describe("recordDecision — the acknowledgement route (C12)", () => {
  /** Captures the request init so the verb and body can be asserted. */
  function stubPost(body: unknown, status = 201) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return response(body, status);
    };
    return { calls, fetchImpl };
  }

  it("posts the decision and the actor, and returns the appended event", async () => {
    const { calls, fetchImpl } = stubPost(DECISION);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    await expect(api.recordDecision("dev-1", "a/b", "acknowledged")).resolves.toEqual(DECISION);

    expect(calls[0]?.url).toBe(`${BASE}/devices/dev-1/alerts/a%2Fb/decisions`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      decision: "acknowledged",
      actor: "web-dashboard",
    });
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("passes an abort signal through when one is given", async () => {
    const { calls, fetchImpl } = stubPost(DECISION);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    const controller = new AbortController();

    await api.recordDecision("dev-1", "a1", "dismissed", controller.signal);

    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("posts without a signal when none is given, and reads a decision back", async () => {
    const { calls, fetchImpl } = stubPost(DECISION);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    await api.recordDecision("dev-1", "a1", "dismissed");

    expect(calls[0]?.init?.signal).toBeUndefined();
  });

  it("reports the server's refusal rather than pretending it landed", async () => {
    const { fetchImpl } = stubPost({ statusCode: 404, message: "unknown alert: ghost" }, 404);
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api
      .recordDecision("dev-1", "ghost", "acknowledged")
      .catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("http");
    expect(error.status).toBe(404);
    expect(error.message).toBe("unknown alert: ghost");
  });

  it("rejects a response that is not a decision event", async () => {
    const { fetchImpl } = stubPost({ ...DECISION, decision: "maybe" });
    const api = createApiClient({ baseUrl: BASE, fetchImpl });

    const error = (await api
      .recordDecision("dev-1", "a1", "acknowledged")
      .catch((cause: unknown) => cause)) as ApiError;
    expect(error.kind).toBe("contract");
  });
});

describe("subscribe — the streaming member (C11)", () => {
  /** A socket the test drives, injected exactly like fetchImpl. */
  function harness() {
    let handlers: SocketHandlers | undefined;
    let url = "";
    const frames: unknown[] = [];
    const alerts: unknown[] = [];
    const decisions: unknown[] = [];
    const silences: unknown[] = [];
    const states: string[] = [];
    const invalid: number[] = [];
    const closed = { count: 0 };

    const api = createApiClient({
      baseUrl: BASE,
      createSocket: (socketUrl, socketHandlers) => {
        url = socketUrl;
        handlers = socketHandlers;
        return {
          close: () => {
            closed.count += 1;
          },
        };
      },
      schedule: () => () => {},
    });

    const subscription = api.subscribe("dev-1", {
      onFrame: (frame) => frames.push(frame),
      onAlert: (alert) => alerts.push(alert),
      onDecision: (decision) => decisions.push(decision),
      onSilence: (episode) => silences.push(episode),
      onState: (state) => states.push(state),
      onReconnect: () => {},
      onInvalidMessage: () => invalid.push(1),
    });

    return {
      url: () => url,
      deliver: (message: unknown) => handlers?.onMessage(JSON.stringify(message)),
      open: () => handlers?.onOpen(),
      frames,
      alerts,
      decisions,
      silences,
      states,
      invalid,
      closed,
      subscription,
    };
  }

  it("opens the device's fan-out route", () => {
    expect(harness().url()).toBe(`${BASE.replace("http", "ws")}/devices/dev-1/stream`);
    expect(streamUrl("https://maekbeat.example/", "a b")).toBe(
      "wss://maekbeat.example/devices/a%20b/stream",
    );
  });

  it("routes frames and alerts to their handlers and ignores the greeting", () => {
    const h = harness();
    h.open();
    h.deliver({ type: "ready", deviceId: "dev-1", serverTimeMs: 1, ringCapacity: 1024 });
    h.deliver({ type: "frame", frame: FRAME });
    h.deliver({ type: "alert", alert: ALERT });
    h.deliver({ type: "decision", decision: DECISION });
    h.deliver({ type: "silence", silence: SILENCE });

    expect(h.frames).toEqual([FRAME]);
    expect(h.alerts).toEqual([ALERT]);
    // A decision another dashboard recorded reaches this one too (C12).
    expect(h.decisions).toEqual([DECISION]);
    // The one message with no frame behind it (C20a). It must not arrive as an
    // alert: a device that stopped sending has no metric to name.
    expect(h.silences).toEqual([SILENCE]);
    expect(h.alerts).toHaveLength(1);
    expect(h.states).toEqual(["connecting", "live"]);
  });

  it("counts a message the contract rejects instead of handing it on", () => {
    const h = harness();
    h.open();
    h.deliver({ type: "frame", frame: { ...FRAME, spo2Pct: 140 } });

    expect(h.frames).toEqual([]);
    expect(h.invalid).toHaveLength(1);
  });

  it("closes the socket when the subscriber closes", () => {
    const h = harness();
    h.open();
    h.subscription.close();
    expect(h.closed.count).toBe(1);
  });

  it("works without the optional invalid-message handler", () => {
    let handlers: SocketHandlers | undefined;
    const api = createApiClient({
      baseUrl: BASE,
      createSocket: (_url, socketHandlers) => {
        handlers = socketHandlers;
        return { close: () => {} };
      },
      schedule: () => () => {},
    });
    api.subscribe("dev-1", {
      onFrame: () => {},
      onAlert: () => {},
      onDecision: () => {},
      onSilence: () => {},
      onState: () => {},
      onReconnect: () => {},
    });
    handlers?.onOpen();
    expect(() => handlers?.onMessage("{not json")).not.toThrow();
  });
});

describe("base URL and the ingest route", () => {
  it("falls back to the development default when VITE_API_BASE_URL is unset or blank", () => {
    expect(resolveApiBaseUrl(undefined)).toBe(DEFAULT_API_BASE_URL);
    expect(resolveApiBaseUrl("   ")).toBe(DEFAULT_API_BASE_URL);
    expect(resolveApiBaseUrl(" https://maekbeat.example ")).toBe("https://maekbeat.example");
  });

  it("derives the WebSocket ingest URL — the socket itself opens at C11", () => {
    expect(ingestUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000/ingest");
    expect(ingestUrl("https://maekbeat.example/")).toBe("wss://maekbeat.example/ingest");
  });
});
