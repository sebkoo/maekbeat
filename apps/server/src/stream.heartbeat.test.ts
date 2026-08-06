import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  Closers,
  startInProcess,
  startSpawnedServer,
  stopAndAwaitExit,
  waitFor,
} from "../test-support";
import { loadConfig } from "./config";
import { STREAM_HEARTBEAT_MS_DEFAULT } from "./stream";

/*
 * The keepalive on a fan-out socket, and the two ways it can be wrong.
 *
 * A dashboard watching a device that has stopped sending receives nothing.
 * That is the ordinary case rather than the broken one — device disconnect is
 * the first failure mode in docs/ARCHITECTURE.md — and until this commit the
 * server sent nothing on that socket either, so the connection carried no
 * bytes for as long as the silence lasted. Every intermediary between the two
 * ends reads that as dead: an AWS load balancer's idle timeout and nginx's
 * `proxy_read_timeout` both default to 60 seconds. The dashboard survives it,
 * because apps/web treats any close as reconnect-and-back-fill (C11), which is
 * exactly what makes the defect quiet — a socket dying on a timer and being
 * rebuilt on the next one looks like a flaky network rather than like a
 * missing keepalive, and the REST back-fill hides the gap.
 *
 * The failure this commit could introduce instead is the timer that outlives
 * its socket. The interval is not `unref()`d, on purpose (src/stream.ts), so a
 * leak holds the event loop open and a SIGTERM never completes — a container
 * that has to be SIGKILLed, which is the C18/C19 failure this repository has
 * already paid for once. That is what the spawned-server test below is for,
 * and it is the reason the timer is ref'd: an unref'd leak would be invisible.
 */

const closers = new Closers();
afterEach(() => closers.closeAll());

/** The schema floor, so the suite waits seconds rather than tens of them. */
const FAST_HEARTBEAT_MS = 1_000;

/**
 * Subscribes and records the two channels separately: WebSocket ping control
 * frames, and application messages. Keeping them apart is the point of the
 * first test — the keepalive must appear in one and never in the other.
 */
async function watchPings(
  port: number,
  deviceId: string,
): Promise<{ pings: () => number; messages: () => string[] }> {
  let pings = 0;
  const messages: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devices/${deviceId}/stream`);
  socket.on("ping", () => (pings += 1));
  socket.on("message", (data: Buffer) => messages.push(data.toString("utf8")));
  closers.add(async () => {
    socket.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { pings: () => pings, messages: () => messages };
}

describe("fan-out heartbeat", () => {
  it("pings an idle subscriber, and the ping is never an application message", async () => {
    const { port } = await startInProcess(closers, {
      STREAM_HEARTBEAT_MS: String(FAST_HEARTBEAT_MS),
    });
    const watcher = await watchPings(port, "heartbeat-idle-001");

    // No device is ingesting, so the only thing this socket can receive is the
    // greeting. Two pings rather than one: one proves a ping was sent, two
    // prove it repeats, and a keepalive that fires once is the same outage on
    // a longer fuse.
    await waitFor(
      () => watcher.pings() >= 2,
      () => `two heartbeat pings; saw ${watcher.pings()}`,
      FAST_HEARTBEAT_MS * 6,
    );

    // The whole reason this is a control frame. `streamMessageSchema` is a
    // strict union and packages/protocol/src/stream.test.ts asserts that
    // `{type:"heartbeat"}` is rejected by it, so a keepalive that arrived here
    // as a message would be dropped as invalid by apps/web's stream client and
    // counted as protocol drift — in both shipped clients, on the same day.
    const messages = watcher.messages();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0] ?? "{}")).toMatchObject({ type: "ready" });
  });

  it("stops pinging when the subscriber leaves, so the process can still exit", async () => {
    // A real process, because the assertion is about the event loop draining
    // and nothing in-process can see that. src/main.ts calls no process.exit
    // on the successful path (src/lifecycle.ts), so this exits if and only if
    // nothing is left holding it — and an interval that outlived its socket is
    // exactly such a thing, since it is deliberately not unref'd.
    const server = await startSpawnedServer({ STREAM_HEARTBEAT_MS: String(FAST_HEARTBEAT_MS) });
    closers.add(async () => {
      server.child.kill("SIGKILL");
    });

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/devices/hb-exit-001/stream`);
    let pings = 0;
    socket.on("ping", () => (pings += 1));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    // Wait for a ping before leaving: a subscriber that disconnects before the
    // first interval fires would pass this test with the timer never armed,
    // which is the setup mistake rather than the guard.
    await waitFor(
      () => pings >= 1,
      () => "the first heartbeat ping before disconnecting",
      FAST_HEARTBEAT_MS * 6,
    );

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
    // Past several more intervals with no subscriber attached. A leaked timer
    // is still firing at this point; a cleared one is gone.
    await new Promise((resolve) => setTimeout(resolve, FAST_HEARTBEAT_MS * 3));

    const { code, signal } = await stopAndAwaitExit(server.child);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 30_000);
});

describe("STREAM_HEARTBEAT_MS", () => {
  it("defaults to the value src/stream.ts states, and coerces a string", () => {
    expect(loadConfig({}).STREAM_HEARTBEAT_MS).toBe(STREAM_HEARTBEAT_MS_DEFAULT);
    expect(loadConfig({ STREAM_HEARTBEAT_MS: "5000" }).STREAM_HEARTBEAT_MS).toBe(5_000);
  });

  it("rejects a value outside the bounds, naming the variable", () => {
    // Zero is the value an operator would reach for to mean "off", and there
    // is no off: a fan-out socket with no keepalive is the defect this
    // variable exists to prevent, so it fails at startup rather than silently
    // restoring the old behaviour.
    for (const value of ["0", "-1", "999", "300001"]) {
      expect(() => loadConfig({ STREAM_HEARTBEAT_MS: value })).toThrow(/STREAM_HEARTBEAT_MS/);
    }
  });
});
