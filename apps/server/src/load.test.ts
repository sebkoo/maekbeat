import type { StreamMessage } from "@maekbeat/protocol";
import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import {
  Closers,
  openSocket,
  restFrame,
  startCollector,
  startInProcess,
  startSpawnedServer,
  stopAndAwaitExit,
  tick,
  waitFor,
  watch,
  type SpawnedServer,
} from "../test-support";
import { parseAlertId } from "./alerts";
import { SEQ_REORDER_WINDOW } from "./store";
import { SPAN_NAMES } from "./tracing";

/*
 * What breaks only under load.
 *
 * Every other suite here drives a handful of frames and asserts the result.
 * That is the right shape for a rule and the wrong shape for three behaviours
 * this server has, two of which had already failed once:
 *
 *   1. C18's stop inversion: a clean stop exited non-zero only when the server
 *      had carried enough traffic to buffer spans, so the servers that did
 *      their job were the ones that failed their stop. An idle test cannot see
 *      it, by construction.
 *   2. Alert timing is receive-time driven, and receive times bunch when the
 *      event loop is busy. "Drift can shift a chart, never an alert" is the
 *      project's rule (docs/ARCHITECTURE.md); under saturation is where it is
 *      tested rather than asserted.
 *   3. Dedupe is what keeps one episode from being raised twice, and a
 *      retransmit re-counted into a window is a second alert for a caregiver.
 *      One socket sending in order cannot produce the interleaving that would
 *      break it.
 *
 * The fan-out send buffer is the fourth thing load found and it is not here.
 * It had no bound at all, which makes it a production change rather than a
 * test, so it lands as its own commit with the test that proves it — the
 * C19 precedent, where a fix inside a large diff is a fix nobody reviews.
 *
 * Everything here waits on an observable condition rather than on a duration:
 * the numbers below are counts of messages, not milliseconds. A CI runner is a
 * far more hostile machine than the one this was written on, and the C11
 * failure that produced test-support.ts was exactly a fixed pause reading as a
 * dropped frame.
 */

const closers = new Closers();
afterEach(() => closers.closeAll());

// ---------------------------------------------------------------------------
// 1 — a stop that follows real traffic
// ---------------------------------------------------------------------------

/**
 * Frames driven before each stop below.
 *
 * Sized against the exporter rather than picked: five spans per frame puts
 * 1500 in the queue, which is over BatchSpanProcessor's 512-span export batch —
 * so exports really happen during the run and a residue is really pending at
 * SIGTERM — and under its 2048-span queue, so nothing is dropped for being
 * over the queue bound instead of over the flush. A number chosen for a round
 * look would make the exact-count assertion below a coin toss.
 */
const STOP_LOAD_FRAMES = 300;

/** Sends `count` frames on one socket and waits for every ack to come back. */
async function drivePlainLoad(port: number, deviceId: string, count: number): Promise<WebSocket> {
  const ws = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
  let acks = 0;
  ws.on("message", (data: Buffer) => {
    if (JSON.parse(data.toString("utf8")).type === "ack") acks += 1;
  });
  for (let seq = 0; seq < count; seq++) ws.send(restFrame(deviceId, seq));
  await waitFor(
    () => acks >= count,
    () => `${count} acks; received ${acks}`,
    20_000,
  );
  return ws;
}

describe("a stop that follows real traffic", () => {
  const servers: SpawnedServer[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }
  });

  it("exits clean and flushes every span the traffic produced", async () => {
    const collector = await startCollector();
    closers.add(() => collector.close());
    const server = await startSpawnedServer({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url,
    });
    servers.push(server);

    // The client stays attached across the stop, which is the shape a real
    // gateway has and the case C18's own test already covers at three frames.
    await drivePlainLoad(server.port, "stop-load-001", STOP_LOAD_FRAMES);

    const exit = await stopAndAwaitExit(server.child);
    expect(exit).toEqual({ code: 0, signal: null });

    // Every frame's root span reached the collector — not "some spans arrived",
    // which a mid-run export batch would satisfy on its own while the shutdown
    // flush dropped everything still queued behind it.
    const roots = collector.spans().filter((span) => span.name === SPAN_NAMES.ingest);
    expect(roots).toHaveLength(STOP_LOAD_FRAMES);
  }, 90_000);

  it("still exits clean when the flush fails, which is C18's inversion", async () => {
    // The defect this is the regression test for: a flush that could not reach
    // its collector decided the exit code, so a server that had carried traffic
    // exited non-zero on every deploy while the collector was down, and an idle
    // one exited clean. The signal was inverted exactly — the busier the
    // server, the more likely a broken stop, and only under load at all.
    //
    // 400 rather than a dead port: it is the one answer the OTLP exporter
    // treats as final, so the flush fails once instead of retrying with
    // backoff, and this stays a test about the exit code.
    const collector = await startCollector({ status: 400 });
    closers.add(() => collector.close());
    const server = await startSpawnedServer({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url,
    });
    servers.push(server);

    await drivePlainLoad(server.port, "stop-load-002", STOP_LOAD_FRAMES);

    const exit = await stopAndAwaitExit(server.child);
    expect(exit).toEqual({ code: 0, signal: null });

    // Telemetry was attempted and refused, rather than never tried — without
    // this the assertion above would pass on a server that had quietly stopped
    // exporting, which is the failure wearing the fix's clothes.
    expect(collector.requests()).toBeGreaterThan(0);
    // And the server said so, at error, on its own way out. This is the line
    // that distinguishes "the flush failed and was not allowed to decide the
    // exit code" from "the flush silently never happened" — which is the same
    // green tick with none of the behaviour.
    expect(server.stdout()).toContain("tracing flush failed during shutdown");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 2 — alerts do not drift under saturation
// ---------------------------------------------------------------------------

/**
 * The journey fixture, unchanged: 220 anomaly frames on seed 7 raise one
 * spo2-low alert at seq 89 and resolve it at seq 152 (src/journey.test.ts
 * derives both). Those two numbers hold under any pacing that keeps the
 * breach and recovery runs inside the 15 s window — which is the property
 * this section puts a busy event loop underneath.
 */
const ALERT_DEVICE = "load-alerts-001";
const ALERT_FRAMES = 220;
const RAISE_SEQ = 89;
const RESOLVE_SEQ = 152;

/**
 * Background devices and frames each, run against the target's replay.
 *
 * 16 000 frames rather than a round few hundred, because the first version of
 * this test paced the flood one round per event-loop turn and the replay
 * finished in 51 ms — the whole background load then landed after the thing it
 * was supposed to be interfering with, and the run asserted equality between
 * two quiet runs. The control below is what now says otherwise.
 */
const BACKGROUND_DEVICES = 8;
const BACKGROUND_FRAMES = 2_000;

/**
 * The fan-out stream of one device, reduced to what a busy machine must not
 * change.
 *
 * Every receive-time-derived value is deliberately out: `receivedAtMs`,
 * `raisedAtMs`, `resolvedAtMs`, and the `raisedAtMs` embedded in the alertId —
 * which is why the id is parsed rather than compared. Those are wall-clock
 * stamps and they differ between any two runs on any machine; a comparison
 * including them would be a comparison of clocks, not of alerts.
 *
 * What is left is the whole of what an alert means: which rule, which
 * lifecycle state, which metric and direction, the per-device raise ordinal,
 * the window statistics the record carries — and, because fan-out publishes a
 * frame before the alert that frame raised, the seq the transition landed on.
 * That last field is what makes this a test of drift rather than of tallies:
 * an alert arriving one frame later is a different string here.
 */
function fanoutShape(messages: StreamMessage[]): string[] {
  const shape: string[] = [];
  let lastSeq = -1;
  for (const message of messages) {
    if (message.type === "ready") continue;
    if (message.type === "frame") {
      lastSeq = message.frame.seq;
      shape.push(`frame#${message.frame.seq}`);
      continue;
    }
    if (message.type !== "alert") continue;
    const parsed = parseAlertId(message.alert.alertId);
    const stats = message.alert.windowStats;
    shape.push(
      [
        `alert#${parsed?.ruleId ?? "unparseable"}`,
        message.alert.state,
        message.alert.metric,
        message.alert.direction,
        `ordinal=${parsed?.ordinal ?? "?"}`,
        `after=${lastSeq}`,
        `samples=${stats.sampleCount}`,
        `breach=${stats.breachCount}`,
        `min=${stats.minValue}`,
        `max=${stats.maxValue}`,
      ].join("|"),
    );
  }
  return shape;
}

/**
 * Replays the anomaly fixture one frame at a time, each awaiting its own ack.
 *
 * Flow control on the target and none on the background is the point: the
 * device under test proceeds at the rate the server can actually serve it,
 * which is what a real gateway does and what makes "the event loop is busy"
 * reach this replay rather than only the sockets beside it.
 */
async function replayAnomaly(
  port: number,
  deviceId: string,
  socket?: WebSocket,
  onAck?: (index: number) => void,
): Promise<void> {
  const ws = socket ?? (await openSocket(`ws://127.0.0.1:${port}/ingest`, closers));
  const frames = takeFrames({ scenario: "anomaly", seed: 7, deviceId }, ALERT_FRAMES);
  let index = 0;
  for (const frame of frames) {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (data: Buffer) => {
        const reply = JSON.parse(data.toString("utf8")) as { type: string };
        if (reply.type !== "ack") reject(new Error(`unexpected reply ${reply.type}`));
        else resolve();
      };
      ws.once("message", onMessage);
      ws.send(JSON.stringify(frame));
    });
    onAck?.(index);
    index += 1;
  }
}

describe("alerts under a saturated event loop", () => {
  it("raises and resolves on the same frames as a quiet run", async () => {
    // The quiet run first: it is the oracle, and it is produced by the same
    // code path rather than written down here. A hand-written expectation
    // would be a second implementation of the alert engine, and the thing
    // under test is the difference between two runs, not the engine.
    const quiet = await startInProcess(closers);
    const quietWatch = await watch(quiet.port, ALERT_DEVICE, closers);
    await replayAnomaly(quiet.port, ALERT_DEVICE);
    await waitFor(
      () => quietWatch.messages.filter((m) => m.type === "frame").length >= ALERT_FRAMES,
      () =>
        `${ALERT_FRAMES} quiet frames; received ${quietWatch.messages.filter((m) => m.type === "frame").length}`,
      20_000,
    );
    const quietShape = fanoutShape(quietWatch.messages);

    // Now the same replay with the machine working: eight other devices
    // streaming continuously, with no flow control of their own, for as long
    // as the device under test is walking its fixture.
    const loaded = await startInProcess(closers);
    const loadedWatch = await watch(loaded.port, ALERT_DEVICE, closers);

    const background = await Promise.all(
      Array.from({ length: BACKGROUND_DEVICES }, () =>
        openSocket(`ws://127.0.0.1:${loaded.port}/ingest`, closers),
      ),
    );
    let backgroundAcks = 0;
    for (const socket of background) {
      socket.on("message", (data: Buffer) => {
        if (JSON.parse(data.toString("utf8")).type === "ack") backgroundAcks += 1;
      });
    }
    // The replay's own socket is opened before the flood starts, so opening it
    // cannot be the pause during which the flood drains.
    const replaySocket = await openSocket(`ws://127.0.0.1:${loaded.port}/ingest`, closers);

    // Continuous rather than pre-queued, and this is the correction that took
    // two red runs to find. Writing all 16 000 frames up front looks like the
    // heavier load and is not: the server drains every one of them before the
    // replay's first frame is even acknowledged — measured, three runs out of
    // three — so the fixture then ran on an idle server after all. One frame
    // per device per event-loop turn, sustained for as long as the replay
    // lasts, is what actually puts other devices' work between this device's
    // frames.
    let flooding = true;
    let backgroundSent = 0;
    const flood = (async () => {
      for (let seq = 0; seq < BACKGROUND_FRAMES && flooding; seq++) {
        for (const [index, socket] of background.entries()) {
          socket.send(restFrame(`load-bg-${index}`, seq));
          backgroundSent += 1;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const startedAt = Date.now();
    let acksAtFirstFrame = -1;
    await replayAnomaly(loaded.port, ALERT_DEVICE, replaySocket, (index) => {
      if (index === 0) acksAtFirstFrame = backgroundAcks;
    });
    const replayMs = Date.now() - startedAt;
    const acksAtLastFrame = backgroundAcks;
    flooding = false;
    await flood;

    await waitFor(
      () => loadedWatch.messages.filter((m) => m.type === "frame").length >= ALERT_FRAMES,
      () =>
        `${ALERT_FRAMES} loaded frames; received ${loadedWatch.messages.filter((m) => m.type === "frame").length}`,
      20_000,
    );
    const loadedShape = fanoutShape(loadedWatch.messages);

    // The control, and getting its shape right took two red runs. It is not
    // "background traffic happened": the first version paced the flood so
    // slowly that all of it landed after the replay had already finished, and
    // the test compared two quiet runs. Nor is it "the background had not
    // finished yet": pre-queued, all 16 000 frames drain before the replay's
    // first acknowledgement, so an upper bound goes red on a server that is
    // working perfectly.
    //
    // What has to be true is that the server did more work for other devices
    // than for this one WHILE serving this one — between the fixture's first
    // acknowledged frame and its last, which is the interval containing the
    // raise and the resolve. That is a shared event loop stated as a number
    // rather than as an intention.
    const backgroundDuringReplay = acksAtLastFrame - acksAtFirstFrame;
    expect(acksAtFirstFrame).toBeGreaterThanOrEqual(0);
    expect(backgroundDuringReplay).toBeGreaterThan(ALERT_FRAMES);

    await waitFor(
      () => backgroundAcks >= backgroundSent,
      () => `${backgroundSent} background acks; saw ${backgroundAcks}`,
      60_000,
    );

    // The replay stayed inside the 15 s alert window, which is the one
    // condition under which the pinned seqs are meaningful at all: a slower
    // machine that took longer would legitimately expire samples and move
    // them, and this says so rather than failing as if the engine had drifted.
    expect(replayMs).toBeLessThan(15_000);

    // The alerts exist. Comparing two empty sequences proves nothing, and this
    // is what stops it.
    const raises = loadedShape.filter((entry) => entry.includes("|raised|"));
    const resolves = loadedShape.filter((entry) => entry.includes("|resolved|"));
    expect(raises).toHaveLength(1);
    expect(resolves).toHaveLength(1);

    // Anchored to the frames src/journey.test.ts derives, in both runs. This
    // is what a widened hysteresis moves: an engine whose thresholds changed
    // still produces two identical runs, so the differential alone would not
    // see it.
    expect(raises[0]).toContain(`after=${RAISE_SEQ}`);
    expect(resolves[0]).toContain(`after=${RESOLVE_SEQ}`);
    expect(quietShape.filter((entry) => entry.includes("|raised|"))[0]).toContain(
      `after=${RAISE_SEQ}`,
    );

    // And the whole interleaving, transition for transition and frame for
    // frame, identical to the quiet run.
    expect(loadedShape).toEqual(quietShape);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3 — dedupe under concurrency
// ---------------------------------------------------------------------------

const DEDUPE_DEVICES = 6;
const DEDUPE_FRAMES = 300;
/** Reorder depth, kept under SEQ_REORDER_WINDOW so this stays late arrivals
 *  rather than the reboot semantics of docs/DECISIONS.md #11. */
const REORDER_DEPTH = 32;

/**
 * A seeded reordering whose worst case is a number rather than a hope: each
 * block of REORDER_DEPTH consecutive seqs is shuffled inside itself and the
 * blocks stay in order, so no frame is ever more than REORDER_DEPTH - 1 below
 * the highest seq already sent.
 *
 * The first version drew from a sliding pool of the same width, which reads as
 * the same thing and is not: an unlucky seq can sit in the pool arbitrarily
 * long, and this run produced regressions deep enough for the store to call
 * them reboots — twenty-nine session epochs on the first device. That is the
 * store behaving exactly as docs/DECISIONS.md #11 says it should; the test was
 * claiming to stay inside a window it had no bound on. Seeded, because CI has
 * to run the attack this machine ran.
 */
function scrambled(count: number, seed: number): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const order: number[] = [];
  for (let start = 0; start < count; start += REORDER_DEPTH) {
    const block = Array.from(
      { length: Math.min(REORDER_DEPTH, count - start) },
      (_unused, offset) => start + offset,
    );
    while (block.length > 0) order.push(block.splice(Math.floor(next() * block.length), 1)[0]!);
  }
  return order;
}

describe("dedupe under concurrency", () => {
  it("drops every duplicate and keeps every in-window frame across parallel devices", async () => {
    const { app, port } = await startInProcess(closers);

    const replies = new Map<string, { acks: Set<number>; duplicates: number; other: number }>();
    const sockets = await Promise.all(
      Array.from({ length: DEDUPE_DEVICES }, async (_unused, index) => {
        const deviceId = `load-dedupe-${index}`;
        const seen = { acks: new Set<number>(), duplicates: 0, other: 0 };
        replies.set(deviceId, seen);
        const socket = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
        socket.on("message", (data: Buffer) => {
          const reply = JSON.parse(data.toString("utf8")) as {
            type: string;
            reason?: string;
            seq?: number;
          };
          if (reply.type === "ack") seen.acks.add(reply.seq!);
          else if (reply.reason === "duplicate") seen.duplicates += 1;
          else seen.other += 1;
        });
        return { deviceId, socket };
      }),
    );

    // Every device's frames reordered inside the window and sent twice, all
    // six streams interleaved round by round — so a duplicate and its original
    // are separated by five other devices' traffic rather than sitting
    // adjacent in one socket's queue.
    const orders = sockets.map(({ deviceId }, index) => ({
      deviceId,
      socket: sockets[index]!.socket,
      order: scrambled(DEDUPE_FRAMES, 1 + index),
      frames: takeFrames({ scenario: "anomaly", seed: 7, deviceId }, DEDUPE_FRAMES) as Record<
        string,
        unknown
      >[],
    }));

    for (let step = 0; step < DEDUPE_FRAMES; step++) {
      for (const { socket, order, frames } of orders) {
        const payload = JSON.stringify(frames[order[step]!]);
        socket.send(payload);
        socket.send(payload);
      }
      if (step % 25 === 0) await tick();
    }

    const expectedReplies = DEDUPE_FRAMES * 2;
    for (const { deviceId } of orders) {
      const seen = replies.get(deviceId)!;
      await waitFor(
        () => seen.acks.size + seen.duplicates + seen.other >= expectedReplies,
        () =>
          `${expectedReplies} replies for ${deviceId}; ` +
          `${seen.acks.size} acks, ${seen.duplicates} duplicates, ${seen.other} other`,
        30_000,
      );
    }

    for (const { deviceId } of orders) {
      const seen = replies.get(deviceId)!;
      // Exactly one accept and one duplicate per frame: nothing counted twice,
      // nothing lost. `other` catches an invalid_frame or invalid_json slipping
      // in, which would otherwise make a missing ack look like a duplicate.
      expect({ deviceId, ...seen, acks: seen.acks.size }).toEqual({
        deviceId,
        acks: DEDUPE_FRAMES,
        duplicates: DEDUPE_FRAMES,
        other: 0,
      });

      // And the frames are all there, once each. DEDUPE_FRAMES is well under
      // RING_CAPACITY, so an absent seq is a dropped frame and not an eviction.
      const read = await app.inject({
        method: "GET",
        url: `/devices/${deviceId}/frames?limit=1000`,
      });
      const body = read.json<{ count: number; frames: { seq: number }[] }>();
      expect(body.count).toBe(DEDUPE_FRAMES);
      expect(body.frames.map((f) => f.seq)).toEqual(
        Array.from({ length: DEDUPE_FRAMES }, (_unused, seq) => seq),
      );
    }

    // No device saw a seq regression deep enough to be read as a reboot: one
    // session each, so the reordering above stayed inside the window it claims
    // to be inside.
    const devices = await app.inject({ method: "GET", url: "/devices" });
    const summary = devices.json<{
      devices: { deviceId: string; sessionEpoch: number; duplicatesDropped: number }[];
    }>();
    for (const device of summary.devices) {
      expect({ id: device.deviceId, epoch: device.sessionEpoch }).toEqual({
        id: device.deviceId,
        epoch: 1,
      });
      expect(device.duplicatesDropped).toBe(DEDUPE_FRAMES);
    }

    // The alerts: unique ids across the whole run, and per device a lifecycle
    // that alternates rather than raising an episode it never resolved. A
    // retransmit re-counted into a window is exactly how a second raise for
    // one episode would appear, which is the caregiver-facing cost of a dedupe
    // that does not hold.
    const everyAlertId = new Set<string>();
    let totalRaised = 0;
    for (const { deviceId } of orders) {
      const read = await app.inject({ method: "GET", url: `/devices/${deviceId}/alerts` });
      const { alerts } = read.json<{
        alerts: { alertId: string; state: string; metric: string }[];
      }>();
      const byRule = new Map<string, string[]>();
      for (const alert of alerts) {
        expect(everyAlertId.has(alert.alertId)).toBe(false);
        everyAlertId.add(alert.alertId);
        const ruleId = parseAlertId(alert.alertId)?.ruleId ?? "unparseable";
        byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), alert.state]);
        if (alert.state !== "resolved") totalRaised += 1;
      }
      for (const [, states] of byRule) {
        // At most one episode open per rule at a time: a `raised` or `ongoing`
        // record may only be the last one in the list.
        const openAt = states.findIndex((state) => state !== "resolved");
        if (openAt >= 0) expect(openAt).toBe(states.length - 1);
      }
    }

    // One episode per device and no more. This is the assertion the whole
    // section is for: a retransmit re-counted into a window, or an out-of-order
    // frame counted twice, shows up here as a seventh alert. It also stops the
    // uniqueness check above from being vacuous over an empty set — the anomaly
    // fixture is used rather than resting frames precisely so alerts exist.
    expect(everyAlertId.size).toBe(DEDUPE_DEVICES);
    expect(totalRaised).toBe(0);
    expect(SEQ_REORDER_WINDOW).toBeGreaterThan(REORDER_DEPTH);
  }, 120_000);
});
