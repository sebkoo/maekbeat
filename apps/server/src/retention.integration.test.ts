import { describe, expect, it } from "vitest";

import { ALERT_HISTORY_LIMIT, type AlertRuleConfig } from "./alerts";
import { buildApp } from "./app";
import { loadConfig } from "./config";

/*
 * The wiring, not the parts. Every unit test in eviction.test.ts builds its own
 * AlertEngine with its own options, so all of them stay green if buildApp
 * forgets to pass `isDecided` at all — the retention judgement would ship
 * inert, the server evicting in arrival order and saying nothing. This file
 * exercises the engine the process actually runs, through the real routes.
 */

const TWITCHY = {
  id: "spo2-low",
  metric: "spo2Pct",
  direction: "low",
  enterThreshold: 90,
  exitThreshold: 95,
  enterCount: 1,
  exitCount: 1,
  windowMs: 1_000,
  cooldownMs: 0,
} satisfies AlertRuleConfig;

/** A running app with `count` finished alert episodes on `deviceId`. */
async function appWithEpisodes(deviceId: string, count: number, warnings: string[] = []) {
  const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {
    alertRules: [TWITCHY],
  });
  // The warn a forced eviction emits is the operational signal; capture it.
  const realWarn = app.log.warn.bind(app.log);
  app.log.warn = ((first: unknown, second?: unknown) => {
    warnings.push(typeof second === "string" ? second : String(first));
    return realWarn(first as never, second as never);
  }) as typeof app.log.warn;

  const frame = (seq: number, spo2Pct: number) => ({
    v: 1 as const,
    deviceId,
    seq,
    capturedAtMs: 1_754_000_000_000 + seq,
    heartRateBpm: 70,
    spo2Pct,
    respirationRpm: 14,
    motion: 0.1,
  });
  app.vitalsStore.ingest(frame(0, 97), 10_000_000);

  let receivedAtMs = 1_000;
  for (let i = 0; i < count; i++) {
    app.alertEngine.process({ ...frame(i * 2, 80), receivedAtMs, sessionEpoch: 1 });
    receivedAtMs += 2_000;
    app.alertEngine.process({ ...frame(i * 2 + 1, 99), receivedAtMs, sessionEpoch: 1 });
    receivedAtMs += 2_000;
  }
  return { app, warnings };
}

const decide = (app: Awaited<ReturnType<typeof buildApp>>, deviceId: string, alertId: string) =>
  app.inject({
    method: "POST",
    url: `/devices/${deviceId}/alerts/${encodeURIComponent(alertId)}/decisions`,
    payload: { decision: "acknowledged", actor: "nurse-station" },
  });

describe("retention, through the app the process runs", () => {
  it("evicts the alert a caregiver triaged, not the one nobody has seen", async () => {
    const { app, warnings } = await appWithEpisodes("evict-dev", ALERT_HISTORY_LIMIT);
    const before = app.alertEngine.listAlerts("evict-dev");
    const triaged = before[30]!;
    const oldestUntriaged = before[0]!;

    expect((await decide(app, "evict-dev", triaged.alertId)).statusCode).toBe(201);

    // One more episode: something must go.
    app.alertEngine.process({
      v: 1,
      deviceId: "evict-dev",
      seq: 9_000,
      capturedAtMs: 1_754_000_009_000,
      heartRateBpm: 70,
      spo2Pct: 80,
      respirationRpm: 14,
      motion: 0.1,
      receivedAtMs: 900_000,
      sessionEpoch: 1,
    });

    const after = (await app.inject({ method: "GET", url: "/devices/evict-dev/alerts" })).json<{
      alerts: Array<{ alertId: string }>;
    }>().alerts;

    expect(after.some((alert) => alert.alertId === triaged.alertId)).toBe(false);
    expect(after.some((alert) => alert.alertId === oldestUntriaged.alertId)).toBe(true);
    expect(warnings).toEqual([]);

    const devices = (await app.inject({ method: "GET", url: "/devices" })).json<{
      devices: Array<{ alertsForcedEvicted: number }>;
    }>().devices;
    expect(devices[0]?.alertsForcedEvicted).toBe(0);
    await app.close();
  });

  it("counts and announces the drop when the whole backlog is untriaged", async () => {
    const { app, warnings } = await appWithEpisodes("busy-dev", ALERT_HISTORY_LIMIT + 3);

    const devices = (await app.inject({ method: "GET", url: "/devices" })).json<{
      devices: Array<{ deviceId: string; alertsForcedEvicted: number }>;
    }>().devices;
    expect(devices.find((d) => d.deviceId === "busy-dev")?.alertsForcedEvicted).toBe(3);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("undecided");
    await app.close();
  });

  it("keeps the count on the device that earned it", async () => {
    const { app } = await appWithEpisodes("noisy-dev", ALERT_HISTORY_LIMIT + 2);
    // A second, quiet device on the same server.
    app.vitalsStore.ingest(
      {
        v: 1,
        deviceId: "quiet-dev",
        seq: 0,
        capturedAtMs: 1_754_000_000_000,
        heartRateBpm: 70,
        spo2Pct: 97,
        respirationRpm: 14,
        motion: 0.1,
      },
      10_000_000,
    );

    const devices = (await app.inject({ method: "GET", url: "/devices" })).json<{
      devices: Array<{ deviceId: string; alertsForcedEvicted: number }>;
    }>().devices;

    expect(devices.find((d) => d.deviceId === "noisy-dev")?.alertsForcedEvicted).toBe(2);
    // A busy ward must not put its backlog on a device nobody needs to look at.
    expect(devices.find((d) => d.deviceId === "quiet-dev")?.alertsForcedEvicted).toBe(0);
    await app.close();
  });

  // The headline safety property, end to end: eviction must not bury an event.
  it("still accepts a decision for an alert eviction has already dropped", async () => {
    const { app } = await appWithEpisodes("gone-dev", ALERT_HISTORY_LIMIT + 2);
    const evicted = `gone-dev:spo2-low:1000:1`;
    const retained = app.alertEngine.listAlerts("gone-dev");
    expect(retained.some((alert) => alert.alertId === evicted)).toBe(false);

    const response = await decide(app, "gone-dev", evicted);

    expect(response.statusCode).toBe(201);
    expect(app.decisionLog.list("gone-dev").map((event) => event.alertId)).toEqual([evicted]);
    await app.close();
  });
});
