import { vitalsFrameSchema, type VitalsFrame } from "@maekbeat/protocol";
import { afterEach, describe, expect, it } from "vitest";

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
