import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import {
  Closers,
  openSocket,
  restFrame,
  startInProcess,
  tick,
  waitFor,
  watch,
} from "../test-support";
import { STREAM_MAX_BUFFERED_BYTES, STREAM_SLOW_SUBSCRIBER_CLOSE } from "./stream";

/*
 * The bound on a subscriber that cannot keep up, and what happens at it.
 *
 * Until C19 the fan-out had no bound at all, and it was the only client-driven
 * memory growth in the server: the frame ring, the alert history, the dedupe
 * set and the inbound payload each carry a number, and `socket.send()` per
 * subscriber carried none. It was recorded as a stated gap in
 * apps/server/README.md and docs/ARCHITECTURE.md and deferred twice, on the
 * argument that picking a threshold before measuring what a subscriber falls
 * behind by would be inventing one. This is the commit that measured it.
 *
 * Bounding a queue forces a second decision that the memory number does not
 * settle: what happens to the messages at the bound. Discarding them quietly
 * is the option this repository cannot take. apps/web breaks the chart line
 * across missing samples and shades the gap rather than interpolating (C11),
 * and C17 found a defect in apps/ios whose entire signature was that the chart
 * healed across a gap while the alarm that belonged in it did not exist. A
 * fan-out that skipped frames and kept the socket open would rebuild exactly
 * that failure one layer down, and would do it invisibly, because a client
 * cannot render a gap it was never told about. So the subscriber is dropped,
 * which is a thing it can see. The decision and the rejected alternative are
 * docs/DECISIONS.md #23.
 */

const closers = new Closers();
afterEach(() => closers.closeAll());

/**
 * A fan-out subscriber that completes the handshake and then never reads a byte.
 *
 * `socket.pause()` is the whole trick, and it is the opposite of what
 * infra/rude-peer.mjs does: that peer reads and discards so the close frame is
 * consumed, deliberately keeping the shutdown case away from backpressure.
 * This one refuses to read, which fills the kernel's socket buffer and then the
 * server's own write queue — the growth that had no bound before this commit.
 */
async function attachStalledSubscriber(port: number, deviceId: string): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  closers.add(async () => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        [
          `GET /devices/${deviceId}/stream HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (chunk: Buffer) => {
      const status = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (!status.startsWith("HTTP/1.1 101")) {
        reject(new Error(`handshake refused: ${status}`));
        return;
      }
      socket.pause();
      resolve();
    });
  });
  return socket;
}

/**
 * An upper bound on each run, not a target. The subscriber is expected to be
 * dropped long before this; every loop below stops the moment it is, and
 * reaching this number means the bound did not hold.
 */
const MAX_FRAMES = 40_000;
const CHUNK = 250;

/** Pushes frames until the server drops a subscriber, or the cap is reached. */
async function ingestUntilDropped(
  app: { deviceBroadcaster: { stats: { slowSubscribersDropped: number } } },
  ingest: WebSocket,
  deviceId: string,
  onChunk?: () => void,
): Promise<number> {
  let sent = 0;
  while (sent < MAX_FRAMES && app.deviceBroadcaster.stats.slowSubscribersDropped === 0) {
    for (let i = 0; i < CHUNK; i++) ingest.send(restFrame(deviceId, sent + i));
    sent += CHUNK;
    await tick();
    onChunk?.();
  }
  await waitFor(
    () => app.deviceBroadcaster.stats.slowSubscribersDropped === 1,
    () => `the stalled subscriber to be dropped; ${sent} frames sent`,
    20_000,
  );
  return sent;
}

describe("a subscriber that stops reading", () => {
  const DEVICE = "bound-stall-001";

  it("is dropped, while a healthy subscriber on the same device is not", async () => {
    const { app, port } = await startInProcess(closers);

    // The control, and it is the C19 polite-peer control one layer out:
    // dropping every subscriber under load would satisfy the memory bound and
    // destroy the feature. This one reads everything it is sent, throughout.
    const healthy = await watch(port, DEVICE, closers);
    const stalled = await attachStalledSubscriber(port, DEVICE);
    await waitFor(
      () => app.deviceBroadcaster.subscriberCount(DEVICE) === 2,
      () => `two subscribers; saw ${app.deviceBroadcaster.subscriberCount(DEVICE)}`,
    );

    const ingest = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
    let acks = 0;
    ingest.on("message", (data: Buffer) => {
      if (JSON.parse(data.toString("utf8")).type === "ack") acks += 1;
    });

    interface QueueingSocket {
      bufferedAmount: number;
    }
    const clients = () =>
      (app as unknown as { websocketServer: { clients: Set<QueueingSocket> } }).websocketServer
        .clients;
    let peakBuffered = 0;
    const samplePeak = () => {
      for (const client of clients()) peakBuffered = Math.max(peakBuffered, client.bufferedAmount);
    };

    const sent = await ingestUntilDropped(app, ingest, DEVICE, samplePeak);
    samplePeak();

    // The bound held on the way there, rather than only at the end. Checking
    // the final value alone would pass a server that queued a hundred megabytes
    // and then dropped: the peak is the memory the process actually had to
    // hold. Measured overshoot on this machine is 241 bytes — one 211-byte
    // fan-out message and its WebSocket header — so the slack is 1 KiB and no
    // more. A generous ceiling would accept a bound that had stopped being one.
    expect(peakBuffered).toBeGreaterThan(0);
    expect(peakBuffered).toBeLessThanOrEqual(STREAM_MAX_BUFFERED_BYTES + 1024);
    expect(sent).toBeLessThan(MAX_FRAMES);

    // The healthy subscriber kept its socket and its data. A bound that sheds
    // the wrong subscriber is not a bound, it is an outage.
    await waitFor(
      () => acks >= sent,
      () => `${sent} acks; received ${acks}`,
      30_000,
    );
    await waitFor(
      () => healthy.frames().length >= sent,
      () => `${sent} frames at the healthy subscriber; received ${healthy.frames().length}`,
      30_000,
    );
    expect(app.deviceBroadcaster.subscriberCount(DEVICE)).toBe(1);
    expect(healthy.frames()).toHaveLength(sent);
    expect(stalled.destroyed).toBe(false);

    // The drop is recorded, not only warned about. The warn goes to stdout and
    // nothing in this repository reads stdout back; src/audit.ts is where a
    // later read path would find it (C22, TH5). Asserted here rather than in a
    // second test because this is the only place a subscriber is actually
    // dropped, and without the assertion the seam was covered but unproven —
    // deleting the call from stream.ts left every suite green.
    const audited = app.auditLog.list().filter((event) => event.kind === "stream.dropped");
    expect(audited.length).toBeGreaterThan(0);
    expect(audited[0]?.deviceId).toBe(DEVICE);
    expect(audited[0]?.detail).toContain("bytes");
    expect(app.auditLog.totals().byKind["stream.dropped"]).toBe(audited.length);
  }, 120_000);
});

describe("what a dropped subscriber can tell", () => {
  const DEVICE = "bound-visible-001";

  it("receives a contiguous prefix and a close, never a stream with holes in it", async () => {
    // The assertion that decides whether this bound is safe at all. The
    // rejected alternative — discard the message, keep the socket — passes a
    // memory test and produces a stream whose gaps are undetectable: the
    // dashboard would draw a continuous line across data it never received,
    // which is the C11 gap rule and the C17 alert-shaped hole both broken from
    // the server side.
    //
    // This subscriber is a real `ws` client whose underlying socket is paused,
    // so the server sees a peer that has stopped reading while the client
    // keeps a parser ready for whatever it eventually gets. Resuming after the
    // drop is what makes the question answerable: everything the server
    // actually sent is then parsed and can be inspected.
    const { app, port } = await startInProcess(closers);

    const slow = await watch(port, DEVICE, closers);
    let closeCode: number | undefined;
    let closeSeen = false;
    slow.socket.on("close", (code: number) => {
      closeCode = code;
      closeSeen = true;
    });
    const underlying = (slow.socket as unknown as { _socket: Socket })._socket;
    underlying.pause();

    const ingest = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
    const sent = await ingestUntilDropped(app, ingest, DEVICE);

    // Now let it read what the server managed to send it.
    underlying.resume();
    await waitFor(
      () => closeSeen,
      () => `the close frame; received ${slow.messages.length} messages`,
      30_000,
    );

    // 1013, Try Again Later — a code that says "reconnect", which is the
    // correct response and the one apps/web already makes on any close.
    expect(closeCode).toBe(STREAM_SLOW_SUBSCRIBER_CLOSE);

    // And the payload it did receive has no holes. Every frame from seq 0 up
    // to wherever the server stopped, in order, with nothing skipped in the
    // middle — so a client can treat "the stream ended" as the whole of what
    // it missed, and back-fill from there.
    const seqs = slow
      .frames()
      .map((message) => (message.type === "frame" ? message.frame.seq : -1));
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, index) => index));
    expect(seqs.length).toBeLessThan(sent);
  }, 120_000);
});

describe("an alert raised while a subscriber is over its bound", () => {
  const DEVICE = "bound-alert-001";

  it("is still there for the reconnect that follows", async () => {
    // The composition risk this fix could introduce, and the reason it is
    // tested rather than reasoned about. C17 found that apps/ios `backfill()`
    // re-read frames and not alerts, so an episode opening during a socket
    // outage produced no fan-out message and nothing ever asked again — the
    // chart healed across the gap and the alarm did not exist. A bound that
    // drops subscribers manufactures exactly that outage, deliberately, and it
    // must not also take the alert with it.
    //
    // The fan-out does not replay: it is a live push, and a transition that
    // happened while nobody was attached is not re-sent to whoever attaches
    // next. That is by design and it is why the recovery path is a read. What
    // this asserts is the server's half of that contract — the alert survives
    // the outage in a place a reconnecting client can find it.
    // The stalled subscriber is the ONLY one, which is the caregiver case: one
    // dashboard, on a connection that cannot keep up, dropped — and then the
    // episode starts with nobody attached at all. An earlier version of this
    // test left a healthy subscriber watching alongside, and a mutation that
    // skipped the alert engine whenever nothing was subscribed walked straight
    // past it (docs/ai/mutation-log.md). A test of an outage has to contain
    // the outage.
    const { app, port } = await startInProcess(closers);

    const stalled = await attachStalledSubscriber(port, DEVICE);
    await waitFor(
      () => app.deviceBroadcaster.subscriberCount(DEVICE) === 1,
      () => `the stalled subscriber; saw ${app.deviceBroadcaster.subscriberCount(DEVICE)}`,
    );

    const ingest = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
    const sent = await ingestUntilDropped(app, ingest, DEVICE);
    expect(app.deviceBroadcaster.stats.slowSubscribersDropped).toBe(1);
    // Nobody is watching this device now. That is the state the episode below
    // has to survive.
    expect(app.deviceBroadcaster.subscriberCount(DEVICE)).toBe(0);

    // The episode happens now, with the stalled subscriber gone. Seqs continue
    // past the resting frames so nothing here is deduped as a retransmit; the
    // engine judges values and receive times, so renumbering changes nothing
    // it looks at.
    const anomaly = takeFrames({ scenario: "anomaly", seed: 7, deviceId: DEVICE }, 220);
    let acks = 0;
    ingest.on("message", (data: Buffer) => {
      if (JSON.parse(data.toString("utf8")).type === "ack") acks += 1;
    });
    anomaly.forEach((frame, index) => {
      ingest.send(JSON.stringify({ ...frame, seq: sent + index }));
    });
    await waitFor(
      () => acks >= anomaly.length,
      () => `${anomaly.length} acks for the episode; received ${acks}`,
      30_000,
    );

    // The reconnect, as the dashboard performs it: a fresh subscription, and a
    // read of the alert history. The socket carries only what happens from now
    // on — asserted, so that "the fan-out does not replay" is a property this
    // suite knows rather than a sentence in a comment.
    const reconnected = await watch(port, DEVICE, closers);
    expect(reconnected.messages.filter((m) => m.type === "alert")).toHaveLength(0);

    const read = await app.inject({ method: "GET", url: `/devices/${DEVICE}/alerts` });
    const body = read.json<{
      counters: { raised: number; resolved: number };
      alerts: { alertId: string; metric: string; state: string }[];
    }>();

    // The alert raised during the outage is there, in the place C11's
    // back-fill and C17's corrected `backfill()` both read from.
    expect(body.counters.raised).toBe(1);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ metric: "spo2Pct", state: "resolved" });
    expect(stalled.destroyed).toBe(false);
  }, 120_000);
});
