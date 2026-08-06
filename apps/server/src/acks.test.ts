import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { DecisionLog } from "./acks";
import { graceForAbsence, waitFor } from "../test-support";
import { buildApp } from "./app";
import { loadConfig } from "./config";

describe("DecisionLog", () => {
  it("appends rather than updates: a change of mind keeps both events", () => {
    const log = new DecisionLog();

    const first = log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "acknowledged",
      actor: "nurse-station",
      recordedAtMs: 1_000,
    });
    const second = log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "dismissed",
      actor: "nurse-station",
      recordedAtMs: 2_000,
      note: "motion artefact",
    });

    expect(log.list("dev-1")).toEqual([first, second]);
    expect(first.eventId).not.toBe(second.eventId);
    // The decision in force is the newest; the earlier one is still readable.
    expect(log.countsFor("dev-1")).toEqual({ acknowledged: 0, dismissed: 1 });
    expect(log.list("dev-1")[0]?.decision).toBe("acknowledged");
  });

  it("counts the decisions in force, one per alert", () => {
    const log = new DecisionLog();
    log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 1,
    });
    log.append({
      deviceId: "dev-1",
      alertId: "a2",
      decision: "dismissed",
      actor: "a",
      recordedAtMs: 2,
    });
    log.append({
      deviceId: "dev-1",
      alertId: "a3",
      decision: "dismissed",
      actor: "a",
      recordedAtMs: 3,
    });

    expect(log.countsFor("dev-1")).toEqual({ acknowledged: 1, dismissed: 2 });
  });

  it("keeps devices apart and answers empty for one it has never seen", () => {
    const log = new DecisionLog();
    log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 1,
    });

    expect(log.list("dev-2")).toEqual([]);
    expect(log.countsFor("dev-2")).toEqual({ acknowledged: 0, dismissed: 0 });
  });

  it("answers isDecided per device, never across them", () => {
    const log = new DecisionLog();
    log.append({
      deviceId: "dev-2",
      alertId: "shared-id",
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 1,
    });

    expect(log.isDecided("dev-2", "shared-id")).toBe(true);
    // Device scoping is what stops one device's decision from authorising an
    // eviction on another device's alert history.
    expect(log.isDecided("dev-1", "shared-id")).toBe(false);
    expect(log.isDecided("dev-2", "other-id")).toBe(false);
  });

  it("bounds retention by dropping the oldest events, never by rewriting one", () => {
    const log = new DecisionLog(3);
    for (let i = 1; i <= 5; i++) {
      log.append({
        deviceId: "dev-1",
        alertId: `a${i}`,
        decision: "acknowledged",
        actor: "a",
        recordedAtMs: i,
      });
    }

    const kept = log.list("dev-1");
    expect(kept.map((event) => event.alertId)).toEqual(["a3", "a4", "a5"]);
    expect(kept.map((event) => event.eventId)).toEqual([
      "dev-1:decision:3",
      "dev-1:decision:4",
      "dev-1:decision:5",
    ]);
  });

  // Append-only has to be a property of the objects, not a promise about the
  // callers: the log hands out a copied array of frozen events.
  it("cannot be edited through what it hands out", () => {
    const log = new DecisionLog();
    const appended = log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 1,
    });

    // The array is a copy…
    (log.list("dev-1") as unknown as unknown[]).pop();
    expect(log.list("dev-1")).toHaveLength(1);

    // …and every event in it is frozen, including the one just returned.
    expect(Object.isFrozen(appended)).toBe(true);
    const stored = log.list("dev-1")[0]!;
    expect(() => {
      (stored as { decision: string }).decision = "dismissed";
    }).toThrow(TypeError);
    expect(log.list("dev-1")[0]?.decision).toBe("acknowledged");
    expect(log.countsFor("dev-1")).toEqual({ acknowledged: 1, dismissed: 0 });
  });

  // The engine clamps its window clock the same way (apps/server/src/alerts.ts):
  // a clock step back must not let an older decision outrank a newer one.
  it("keeps recorded timestamps monotonic across a clock step back", () => {
    const log = new DecisionLog();
    log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "acknowledged",
      actor: "a",
      recordedAtMs: 5_000,
    });
    const second = log.append({
      deviceId: "dev-1",
      alertId: "a1",
      decision: "dismissed",
      actor: "a",
      recordedAtMs: 1_000,
    });

    expect(second.recordedAtMs).toBe(5_000);
    // The newer append is the decision in force, whatever the clock said.
    expect(log.countsFor("dev-1")).toEqual({ acknowledged: 0, dismissed: 1 });
  });
});

describe("POST /devices/:deviceId/alerts/:alertId/decisions", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  /** A server carrying one raised alert on `sim-ack`. */
  async function serverWithAlert() {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      await app.close();
    });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const base = `127.0.0.1:${address.port}`;

    const ingest = new WebSocket(`ws://${base}/ingest`);
    closers.push(async () => {
      ingest.close();
    });
    await new Promise<void>((resolve, reject) => {
      ingest.once("open", () => resolve());
      ingest.once("error", reject);
    });
    for (const frame of takeFrames({ scenario: "anomaly", seed: 7, deviceId: "sim-ack" }, 110)) {
      ingest.send(JSON.stringify(frame));
    }
    // Ingest is a socket, so the frames arrive when they arrive. A fixed pause
    // here made every test in this file depend on how loaded the machine was.
    await waitFor(
      () => app.alertEngine.listAlerts("sim-ack").length > 0,
      () => `the anomaly to raise an alert; ${app.alertEngine.listAlerts("sim-ack").length} raised`,
    );

    const alerts = app.alertEngine.listAlerts("sim-ack");
    expect(alerts.length).toBeGreaterThan(0);
    return { app, base, alertId: alerts[0]!.alertId };
  }

  it("appends the decision and returns it", async () => {
    const { app, base, alertId } = await serverWithAlert();

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(alertId)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(201);
    const event = (await response.json()) as Record<string, unknown>;
    expect(event).toMatchObject({
      alertId,
      deviceId: "sim-ack",
      decision: "acknowledged",
      actor: "web-dashboard",
    });
    expect(typeof event.recordedAtMs).toBe("number");
    expect(app.decisionLog.list("sim-ack")).toHaveLength(1);
  });

  it("serves the log and the in-force counts on the alerts read", async () => {
    const { base, alertId } = await serverWithAlert();
    const post = (decision: string) =>
      fetch(`http://${base}/devices/sim-ack/alerts/${encodeURIComponent(alertId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, actor: "web-dashboard" }),
      });

    await post("acknowledged");
    await post("dismissed");

    const read = (await (await fetch(`http://${base}/devices/sim-ack/alerts`)).json()) as {
      counters: Record<string, number>;
      decisions: Array<{ decision: string }>;
    };
    expect(read.decisions.map((event) => event.decision)).toEqual(["acknowledged", "dismissed"]);
    expect(read.counters.acknowledged).toBe(0);
    expect(read.counters.dismissed).toBe(1);
  });

  it("fans the decision out to a watching dashboard", async () => {
    const { base, alertId } = await serverWithAlert();
    const dash = new WebSocket(`ws://${base}/devices/sim-ack/stream`);
    const received: Array<Record<string, unknown>> = [];
    dash.on("message", (data) => received.push(JSON.parse(data.toString())));
    closers.push(async () => {
      dash.close();
    });
    await new Promise<void>((resolve, reject) => {
      dash.once("open", () => resolve());
      dash.once("error", reject);
    });

    await fetch(`http://${base}/devices/sim-ack/alerts/${encodeURIComponent(alertId)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismissed", actor: "web-dashboard" }),
    });
    const decisionsSoFar = () => received.filter((message) => message.type === "decision");
    await waitFor(
      () => decisionsSoFar().length >= 1,
      () => `the decision to fan out; received ${received.length} messages`,
    );
    // One decision was posted, so a second would be a bug. That is an absence,
    // and no amount of polling proves an absence — the grace covers the gap
    // between the message that should arrive and one that should not.
    await graceForAbsence();

    const decisions = decisionsSoFar();
    expect(decisions).toHaveLength(1);
    expect((decisions[0]?.decision as { decision: string }).decision).toBe("dismissed");
  });

  it("refuses a malformed alertId rather than logging a shape it cannot read", async () => {
    const { app, base } = await serverWithAlert();

    const response = await fetch(`http://${base}/devices/sim-ack/alerts/ghost/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      message: "malformed alertId: ghost",
    });
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  it("refuses an alertId that belongs to another device", async () => {
    const { app, base } = await serverWithAlert();
    const foreign = "other-dev:spo2-low:1754000000000:1";

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(foreign)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      message: `alert ${foreign} does not belong to sim-ack`,
    });
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  // Owned and well formed is not the same as plausible: without the record,
  // the rule, the ordinal and the raise time are still checkable against what
  // this engine could have minted.
  it("refuses an alertId naming a rule this engine does not judge by", async () => {
    const { app, base } = await serverWithAlert();
    const invented = "sim-ack:made-up-rule:1754000000000:1";

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(invented)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      message: "unknown alert rule: made-up-rule",
    });
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  it("refuses a raise ordinal this device has never reached", async () => {
    const { app, base } = await serverWithAlert();
    const raised = app.alertEngine.countersFor("sim-ack").raised;
    const beyond = `sim-ack:spo2-low:1754000000000:${raised + 1}`;

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(beyond)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(404);
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  it("refuses an alert claiming to have been raised in the future", async () => {
    const { app, base } = await serverWithAlert();
    const future = `sim-ack:spo2-low:${Date.now() + 600_000}:1`;

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(future)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "acknowledged", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(404);
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  // The log outlives the ring: an alert the history has already dropped must
  // still be decidable, or the cache could bury a real event for good.
  it("accepts a decision for an alert the history no longer holds", async () => {
    const { app, base } = await serverWithAlert();
    const evicted = "sim-ack:spo2-low:1754000000000:1";
    expect(app.alertEngine.listAlerts("sim-ack").some((a) => a.alertId === evicted)).toBe(false);

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(evicted)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "dismissed", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(201);
    expect(app.decisionLog.list("sim-ack").map((event) => event.alertId)).toEqual([evicted]);
  });

  it("refuses an unknown key in the body rather than silently dropping it", async () => {
    const { app, base, alertId } = await serverWithAlert();

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(alertId)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "acknowledged",
          actor: "web-dashboard",
          supersedes: "some-other-event",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });

  it("refuses a decision the contract does not know", async () => {
    const { app, base, alertId } = await serverWithAlert();

    const response = await fetch(
      `http://${base}/devices/sim-ack/alerts/${encodeURIComponent(alertId)}/decisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe-later", actor: "web-dashboard" }),
      },
    );

    expect(response.status).toBe(400);
    // Names which validator answered, so a silently-removed check shows up.
    expect(((await response.json()) as { message: string }).message).toContain("body/decision");
    expect(app.decisionLog.list("sim-ack")).toHaveLength(0);
  });
});
