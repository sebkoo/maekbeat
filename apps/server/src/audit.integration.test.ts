import { describe, expect, it } from "vitest";

import { ALERT_HISTORY_LIMIT, type AlertRuleConfig } from "./alerts";
import { buildApp } from "./app";
import { loadConfig } from "./config";

/*
 * The wiring, not the class. src/audit.test.ts proves AuditLog records what it
 * is handed; every one of those tests stays green if buildApp never calls it,
 * and the log would ship inert — the server discarding alerts silently while a
 * fully tested class sat beside it holding nothing.
 *
 * That is H5's shape and this repository has paid for it once already: the
 * shipped iOS app opened no socket at C17 with a green suite. So this file
 * drives the app the process actually runs and asks the decorated log what it
 * saw.
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

const frame = (deviceId: string, seq: number, spo2Pct: number) => ({
  v: 1 as const,
  deviceId,
  seq,
  capturedAtMs: 1_754_000_000_000 + seq,
  heartRateBpm: 70,
  spo2Pct,
  respirationRpm: 14,
  motion: 0.1,
});

describe("the audit log, through the app the process runs", () => {
  it("records a forced alert eviction that would otherwise reach only stdout", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {
      alertRules: [TWITCHY],
    });
    const deviceId = "audit-dev";

    expect(app.auditLog.totals().recorded).toBe(0);

    // Fill the history with undecided episodes, then force one more. Nothing is
    // decided, so the engine has no triaged alert to drop and must force it.
    let receivedAtMs = 1_000;
    for (let i = 0; i <= ALERT_HISTORY_LIMIT; i++) {
      app.alertEngine.process({ ...frame(deviceId, i * 2, 80), receivedAtMs, sessionEpoch: 1 });
      receivedAtMs += 2_000;
      app.alertEngine.process({ ...frame(deviceId, i * 2 + 1, 99), receivedAtMs, sessionEpoch: 1 });
      receivedAtMs += 2_000;
    }

    const totals = app.auditLog.totals();
    expect(totals.byKind["alert.evicted"]).toBeGreaterThan(0);
    expect(totals.recorded).toBe(totals.byKind["alert.evicted"]);

    const recorded = app.auditLog.list();
    expect(recorded[0]?.kind).toBe("alert.evicted");
    expect(recorded[0]?.deviceId).toBe(deviceId);
    expect(recorded[0]?.detail).toContain("history full of undecided alerts");

    // The engine's own counter and the audit log agree on how many were forced.
    expect(app.alertEngine.countersFor(deviceId).forcedEvictions).toBe(
      totals.byKind["alert.evicted"],
    );

    await app.close();
  });

  it("is decorated onto the app, so a later read path has something to read", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));

    // Recorded, not detectable: nothing serves this today. The decoration is
    // the whole read surface, and this asserts it exists rather than implying
    // a route does.
    expect(app.auditLog.totals()).toEqual({
      recorded: 0,
      evicted: 0,
      retained: 0,
      byKind: { "alert.evicted": 0, "silence.evicted": 0, "stream.dropped": 0 },
    });

    const routes = app.printRoutes();
    expect(routes).not.toContain("audit");

    await app.close();
  });
});
