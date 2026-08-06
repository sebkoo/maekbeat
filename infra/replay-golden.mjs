/*
 * Does the container serve the real system?
 *
 * A Dockerfile that builds, a container that starts and a healthcheck that
 * goes green say the process is alive. They say nothing about whether it
 * ingests, evaluates and fans out — and every one of those can be broken by a
 * missing file, a stripped dependency or a wrong entry point while /healthz
 * answers happily.
 *
 * So this replays packages/vitals-sim/golden/anomaly.ndjson — the same bytes
 * the TypeScript golden gate, the C18 trace-shape test and the Swift decode
 * tests read — into the containerised server over the real /ingest socket, and
 * asserts the alert that comes out and the fan-out message a subscriber
 * receives. The goldens are the cross-language contract, so they are the
 * oracle here too: the expectations below are the ones apps/server's in-process
 * suites make of the same fixture, asked of a container instead.
 *
 *   node infra/replay-golden.mjs http://127.0.0.1:3000
 *
 * Exits 0 when every assertion holds, 1 with the failure named otherwise.
 * Uses Node's built-in WebSocket (22.4+) and nothing else, so it runs from a
 * checkout with no install.
 */

import { readFileSync } from "node:fs";

const apiUrl = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const wsUrl = apiUrl.replace(/^http/, "ws");
const GOLDEN = new URL("../packages/vitals-sim/golden/anomaly.ndjson", import.meta.url);

/*
 * The fixture's own device id. Replaying into a server that has already seen
 * this device would produce a second session rather than the first, so this
 * script expects a stack that was just brought up — infra/compose-smoke.sh
 * runs it before anything else touches the API.
 */
const DEVICE_ID = "sim-001";

const failures = [];

/** Records a failure instead of throwing, so one run reports every problem. */
function check(condition, description, detail) {
  if (condition) {
    console.log(`  ok   ${description}`);
    return;
  }
  failures.push(detail === undefined ? description : `${description} — ${detail}`);
  console.log(`  FAIL ${description}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** The fixture's frames, without its header line. */
function goldenFrames() {
  return readFileSync(GOLDEN, "utf8")
    .split("\n")
    .slice(1, -1)
    .map((line) => JSON.parse(line));
}

function open(url, protocolLabel) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${protocolLabel}: no open within 10 s`)),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${protocolLabel}: socket error before open`));
    });
  });
}

/**
 * Sends one frame and waits for the server's reply.
 *
 * One at a time on purpose. Firing all 120 and counting replies afterwards
 * would pass on a server that answers a fixed number of times regardless of
 * what it was sent, which is the shape of an ingest path that has stopped
 * reading its input.
 */
function sendAndAwaitReply(socket, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      socket.removeEventListener("message", onMessage);
      resolve(JSON.parse(String(event.data)));
    };
    socket.addEventListener("message", onMessage);
    // The close listener is registered once for the socket, not once per frame:
    // a per-call one leaks 120 listeners and Node says so at eleven.
    closeFailures.push(reject);
    socket.send(payload);
  });
}

/** Pending replies to reject if the ingest socket dies mid-replay. */
const closeFailures = [];

async function getJson(path) {
  const response = await fetch(`${apiUrl}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
}

console.log(`replaying anomaly.ndjson into ${apiUrl}`);

// The subscriber attaches first. A dashboard that connects after the episode
// has already been raised reads the alert out of history on its next REST poll,
// so subscribing late would test the read path a second time and the fan-out
// path not at all.
const stream = await open(`${wsUrl}/devices/${DEVICE_ID}/stream`, "stream");
const streamMessages = [];
stream.addEventListener("message", (event) => {
  streamMessages.push(JSON.parse(String(event.data)));
});

const frames = goldenFrames();
const ingest = await open(`${wsUrl}/ingest`, "ingest");
let replayDone = false;
ingest.addEventListener("close", () => {
  if (replayDone) return;
  for (const reject of closeFailures) reject(new Error("ingest socket closed mid-replay"));
});
const replies = [];
for (const frame of frames) {
  replies.push(await sendAndAwaitReply(ingest, JSON.stringify(frame)));
}
replayDone = true;
ingest.close();

// Fan-out is asynchronous, so the alert message can trail the last ack. Wait
// for the condition rather than for a fixed pause (apps/server/test-support.ts
// records why that distinction cost a red build once).
const deadline = Date.now() + 5_000;
while (Date.now() < deadline && !streamMessages.some((m) => m.type === "alert")) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const alerts = await getJson(`/devices/${DEVICE_ID}/alerts`);

console.log("\nassertions");
check(replies.length === frames.length, `every frame is answered (${frames.length})`);
check(
  replies.every((reply) => reply.type === "ack"),
  "every reply is an ack",
  replies.find((reply) => reply.type !== "ack")?.reason,
);

// The anomaly fixture desaturates once and recovers: one episode, raised then
// resolved, on the spo2-low rule. Anything else means the alert engine in the
// container is not the alert engine the suites gate.
check(
  alerts.alerts.length === 1,
  "the fixture raises exactly one alert",
  `got ${alerts.alerts.length}`,
);
const alert = alerts.alerts[0];
check(
  typeof alert?.alertId === "string" && alert.alertId.startsWith(`${DEVICE_ID}:spo2-low:`),
  "the alert is the spo2-low episode",
  alert?.alertId,
);
check(
  alert?.metric === "spo2Pct" && alert?.direction === "low",
  "on spo2Pct, low",
  `${alert?.metric}/${alert?.direction}`,
);
check(alert?.state === "resolved", "and it resolved before the fixture ended", alert?.state);

const ready = streamMessages.find((message) => message.type === "ready");
check(ready?.deviceId === DEVICE_ID, "the subscriber was greeted with a ready message");
const framesSeen = streamMessages.filter((message) => message.type === "frame").length;
check(
  framesSeen === frames.length,
  `the subscriber received every frame (${frames.length})`,
  `got ${framesSeen}`,
);

// The point of the whole script: a subscriber that was already connected
// learned about the alert without asking. Transitions, plural — a raise and a
// resolve — carrying the same alertId the REST read serves, because an
// alertId a responder pastes into a query has to be the one both paths mean.
const alertMessages = streamMessages.filter((message) => message.type === "alert");
check(
  alertMessages.length === 2,
  "the subscriber received both transitions",
  `got ${alertMessages.length}`,
);
check(
  alertMessages.every((message) => message.alert.alertId === alert?.alertId),
  "fanned out under the alertId the REST read serves",
);
check(
  alertMessages.map((message) => message.alert.state).join(",") === "raised,resolved",
  "raised, then resolved",
  alertMessages.map((message) => message.alert.state).join(","),
);

stream.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nthe container serves the system the goldens describe.");
