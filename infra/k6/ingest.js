import { WebSocket } from "k6/experimental/websockets";
import { Counter, Trend } from "k6/metrics";
import { setTimeout, setInterval, clearInterval } from "k6/timers";

/*
 * Ingest throughput and acknowledgement latency, driven at the WebSocket
 * contract rather than at HTTP: /ingest takes one JSON vitals frame per
 * message and answers each with an ack or a rejection, so a frame that was
 * accepted is a frame that came back, and throughput here is acknowledged
 * frames per second rather than bytes pushed at a socket.
 *
 * Every number this produces describes one laptop under one runtime. Nothing
 * here is a capacity claim; infra/README.md carries the environment beside the
 * measurements and the reason they do not gate CI is docs/DECISIONS.md #24.
 */

const acked = new Counter("frames_acked");
const rejected = new Counter("frames_rejected");
const ackLatency = new Trend("ack_latency_ms", true);

const API = __ENV.API_URL || "ws://server:3000";
const RUN_MS = Number(__ENV.RUN_MS || 30000);
/** Frames per second per virtual device. */
const RATE_HZ = Number(__ENV.RATE_HZ || 50);
/** Devices per VU; each VU holds one socket and multiplexes its devices on it,
 *  which is what an iOS gateway does for the peripherals it has paired. */
const DEVICES_PER_VU = Number(__ENV.DEVICES_PER_VU || 1);
/** Drive values through the spo2-low threshold so the alert path is exercised. */
const BREACH = __ENV.BREACH === "1";

export const options = {
  scenarios: {
    // One session per VU, not a stream of restarted iterations: a VU that
    // finishes its run and immediately opens a second socket would count a
    // reconnect storm as throughput and report more frames than the profile
    // describes.
    ingest: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.VUS || 4),
      iterations: 1,
      maxDuration: `${Math.ceil(RUN_MS / 1000) + 20}s`,
    },
  },
  // Set under the measured floor with headroom, and they are a smoke signal
  // rather than a capacity claim: a run that suddenly cannot acknowledge a
  // frame inside a second, or that rejects anything at all, is broken in a way
  // worth failing on. infra/README.md records what they were set against.
  thresholds: {
    ack_latency_ms: [`p(95)<${__ENV.ACK_P95_MS || 1000}`],
    frames_rejected: ["count==0"],
  },
};

/** One frame on the wire, shaped by packages/protocol vitalsFrameSchema. */
function frame(deviceId, seq, breaching) {
  return JSON.stringify({
    v: 1,
    deviceId,
    seq,
    capturedAtMs: Date.now(),
    heartRateBpm: 62 + (seq % 7),
    spo2Pct: breaching ? 86.5 : 97.5,
    respirationRpm: 14,
    motion: 0.01,
  });
}

export default function () {
  const socket = new WebSocket(`${API}/ingest`);
  const sentAt = new Map();
  let seq = 0;

  socket.onmessage = (event) => {
    const reply = JSON.parse(event.data);
    const key = `${reply.deviceId}:${reply.seq}`;
    const started = sentAt.get(key);
    if (started !== undefined) {
      ackLatency.add(Date.now() - started);
      sentAt.delete(key);
    }
    if (reply.type === "ack") acked.add(1);
    else rejected.add(1);
  };

  socket.onopen = () => {
    const tick = setInterval(() => {
      for (let d = 0; d < DEVICES_PER_VU; d++) {
        // The device id carries the VU, so parallel VUs never share a device
        // and never contend on one device's dedupe set or alert windows.
        const deviceId = `k6-${__VU}-${d}`;
        // A breach run desaturates for a stretch and recovers, so the engine
        // raises and resolves rather than latching on forever.
        const breaching = BREACH && seq % 200 >= 40 && seq % 200 < 100;
        sentAt.set(`${deviceId}:${seq}`, Date.now());
        socket.send(frame(deviceId, seq, breaching));
      }
      seq += 1;
    }, 1000 / RATE_HZ);

    setTimeout(() => {
      clearInterval(tick);
      socket.close();
    }, RUN_MS);
  };

  socket.onerror = (error) => {
    throw new Error(`ingest socket error: ${error && error.error ? error.error() : error}`);
  };
}
