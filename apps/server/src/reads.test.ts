import { alertEventSchema, vitalsFrameSchema, type VitalsFrame } from "@maekbeat/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ALERT_HISTORY_LIMIT } from "./alerts";
import { buildApp } from "./app";
import { loadConfig } from "./config";

function frame(overrides: Partial<VitalsFrame> = {}): VitalsFrame {
  return {
    v: 1,
    deviceId: "rest-dev",
    seq: 0,
    capturedAtMs: 1_000,
    heartRateBpm: 64,
    spo2Pct: 97,
    respirationRpm: 13,
    motion: 0,
    ...overrides,
  };
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function seededApp() {
  app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
  // Arrival order deliberately disagrees with capture order.
  app.vitalsStore.ingest(frame({ seq: 2, capturedAtMs: 3_000 }), 9_002);
  app.vitalsStore.ingest(frame({ seq: 0, capturedAtMs: 1_000 }), 9_000);
  app.vitalsStore.ingest(frame({ seq: 1, capturedAtMs: 2_000 }), 9_001);
  return app;
}

describe("GET /devices", () => {
  // A backlog nobody is triaging is an operational signal, so the count of
  // alerts dropped for want of a decided one to drop instead is served, not
  // just held in the engine.
  it("reports forced alert evictions on the device summary", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {
      alertRules: [
        {
          id: "spo2-low",
          metric: "spo2Pct",
          direction: "low",
          enterThreshold: 90,
          exitThreshold: 95,
          enterCount: 1,
          exitCount: 1,
          windowMs: 1_000,
          cooldownMs: 0,
        },
      ],
    });
    const frame = (seq: number, spo2Pct: number) => ({
      v: 1 as const,
      deviceId: "evict-dev",
      seq,
      capturedAtMs: 1_754_000_000_000 + seq,
      heartRateBpm: 70,
      spo2Pct,
      respirationRpm: 14,
      motion: 0.1,
    });
    app.vitalsStore.ingest(frame(0, 97), 1_000);

    // 102 untriaged episodes against a 100-alert history: two must go.
    let receivedAtMs = 1_000;
    for (let i = 0; i < ALERT_HISTORY_LIMIT + 2; i++) {
      app.alertEngine.process({ ...frame(i * 2, 80), receivedAtMs, sessionEpoch: 1 });
      receivedAtMs += 2_000;
      app.alertEngine.process({ ...frame(i * 2 + 1, 99), receivedAtMs, sessionEpoch: 1 });
      receivedAtMs += 2_000;
    }

    const response = await app.inject({ method: "GET", url: "/devices" });
    const body = response.json<{ devices: Array<Record<string, unknown>> }>();
    expect(body.devices[0]?.alertsForcedEvicted).toBe(2);
    await app.close();
  });

  it("lists device summaries with the staleness signal", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ devices: Record<string, unknown>[] }>();
    expect(body.devices).toEqual([
      {
        deviceId: "rest-dev",
        sessionEpoch: 1,
        frameCount: 3,
        lastSeq: 2,
        lastReceivedAtMs: 9_001,
        alertsForcedEvicted: 0,
        duplicatesDropped: 0,
      },
    ]);
  });
});

describe("GET /devices/:deviceId/frames", () => {
  it("returns frames ordered by (capturedAtMs, seq), not arrival", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices/rest-dev/frames" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ count: number; frames: { seq: number }[] }>();
    expect(body.count).toBe(3);
    expect(body.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it("serves the full stored frame: wire fields plus the two server stamps", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices/rest-dev/frames" });
    const first = response.json<{ frames: Record<string, unknown>[] }>().frames[0];

    // Drift guard: REST must expose exactly the protocol fields + server stamps,
    // so a wire-contract change breaks this test instead of silently diverging.
    const wireFields = Object.keys(vitalsFrameSchema.shape);
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [...wireFields, "receivedAtMs", "sessionEpoch"].sort(),
    );
    expect(first).toMatchObject({ seq: 0, capturedAtMs: 1_000, receivedAtMs: 9_000 });
  });

  it("applies since (inclusive) and limit", async () => {
    const server = await seededApp();

    const since = await server.inject({
      method: "GET",
      url: "/devices/rest-dev/frames?since=2000",
    });
    expect(
      since.json<{ frames: { capturedAtMs: number }[] }>().frames.map((f) => f.capturedAtMs),
    ).toEqual([2_000, 3_000]);

    const limited = await server.inject({
      method: "GET",
      url: "/devices/rest-dev/frames?limit=1",
    });
    expect(
      limited.json<{ count: number; frames: { seq: number }[] }>().frames.map((f) => f.seq),
    ).toEqual([0]);
  });

  it("404s an unknown device with the error-handler shape", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices/nobody/frames" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ statusCode: 404, message: "unknown device: nobody" });
  });

  it("400s an out-of-range limit", async () => {
    const server = await seededApp();
    const response = await server.inject({
      method: "GET",
      url: "/devices/rest-dev/frames?limit=0",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /devices/:deviceId/alerts", () => {
  it("returns empty alerts and zero counters for a known, quiet device", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices/rest-dev/alerts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceId: "rest-dev",
      counters: { raised: 0, resolved: 0, suppressed: 0, acknowledged: 0, dismissed: 0 },
      decisions: [],
      alerts: [],
    });
  });

  it("404s an unknown device", async () => {
    const server = await seededApp();
    const response = await server.inject({ method: "GET", url: "/devices/nobody/alerts" });
    expect(response.statusCode).toBe(404);
  });

  it("serves the full lifecycle record; fields track the protocol schema", async () => {
    const server = await seededApp();
    // Drive the engine directly with injected receive times: 5 breaches to
    // raise, 8 recoveries to resolve (DEFAULT_ALERT_RULES spo2-low).
    let tick = 0;
    for (const spo2Pct of [85, 85, 85, 85, 85, 96, 96, 96, 96, 96, 96, 96, 96]) {
      server.alertEngine.process({
        ...frame({ seq: tick, capturedAtMs: 1_000 + tick, spo2Pct }),
        receivedAtMs: 500_000 + tick * 1_000,
        sessionEpoch: 1,
      });
      tick += 1;
    }

    const response = await server.inject({ method: "GET", url: "/devices/rest-dev/alerts" });
    const body = response.json<{
      counters: Record<string, number>;
      alerts: Record<string, unknown>[];
    }>();
    expect(body.counters).toEqual({
      raised: 1,
      resolved: 1,
      suppressed: 0,
      acknowledged: 0,
      dismissed: 0,
    });
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({
      deviceId: "rest-dev",
      metric: "spo2Pct",
      direction: "low",
      state: "resolved",
      raisedAtMs: 504_000,
      resolvedAtMs: 512_000,
    });

    // Drift guard: the REST alert must expose exactly the protocol's
    // alertEventSchema fields, so a contract change breaks here.
    expect(Object.keys(body.alerts[0] ?? {}).sort()).toEqual(
      Object.keys(alertEventSchema.shape).sort(),
    );
    expect(alertEventSchema.safeParse(body.alerts[0]).success).toBe(true);
  });
});
