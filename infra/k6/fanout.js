import { WebSocket } from "k6/experimental/websockets";
import { Counter, Trend } from "k6/metrics";
import { setTimeout, setInterval, clearInterval } from "k6/timers";

/*
 * Fan-out delivery latency: how long after the server stamps a frame does a
 * dashboard watching that device actually have it.
 *
 * The clock question, because it decides whether the number means anything.
 * Each stream message carries the server's own `receivedAtMs`, stamped at
 * ingest, and this script stamps arrival with its own `Date.now()`. The two
 * containers are processes on one kernel and read one wall clock, so the
 * difference is a real interval — server-internal work plus loopback — and not
 * a comparison of two machines' ideas of the time. Run this against a server
 * on another host and the number becomes clock skew instead; that is the
 * reason it runs on the compose network and nowhere else.
 */

const framesSeen = new Counter("fanout_frames_delivered");
const alertsSeen = new Counter("fanout_alerts_delivered");
const deliveryLatency = new Trend("fanout_delivery_ms", true);
const alertLatency = new Trend("fanout_alert_ms", true);

const API = __ENV.API_URL || "ws://server:3000";
const RUN_MS = Number(__ENV.RUN_MS || 30000);
const RATE_HZ = Number(__ENV.RATE_HZ || 50);
const DEVICES = Number(__ENV.DEVICES || 4);
const BREACH = __ENV.BREACH === "1";

export const options = {
  scenarios: {
    fanout: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: `${Math.ceil(RUN_MS / 1000) + 20}s`,
    },
  },
  thresholds: {
    fanout_delivery_ms: [`p(95)<${__ENV.FANOUT_P95_MS || 1000}`],
    fanout_frames_delivered: ["count>0"],
  },
};

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
  const devices = Array.from({ length: DEVICES }, (_unused, index) => `k6-fanout-${index}`);
  let openSubscribers = 0;

  // One subscriber per device, each measuring its own delivery.
  for (const deviceId of devices) {
    const dash = new WebSocket(`${API}/devices/${deviceId}/stream`);
    dash.onopen = () => {
      openSubscribers += 1;
    };
    dash.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "frame") {
        framesSeen.add(1);
        deliveryLatency.add(Date.now() - message.frame.receivedAtMs);
      } else if (message.type === "alert") {
        alertsSeen.add(1);
        const raised = message.alert.resolvedAtMs || message.alert.raisedAtMs;
        alertLatency.add(Date.now() - raised);
      }
    };
    setTimeout(() => dash.close(), RUN_MS + 2000);
  }

  const ingest = new WebSocket(`${API}/ingest`);
  let seq = 0;
  ingest.onmessage = () => {};
  ingest.onopen = () => {
    const tick = setInterval(() => {
      const breaching = BREACH && seq % 200 >= 40 && seq % 200 < 100;
      for (const deviceId of devices) ingest.send(frame(deviceId, seq, breaching));
      seq += 1;
    }, 1000 / RATE_HZ);
    setTimeout(() => {
      clearInterval(tick);
      ingest.close();
    }, RUN_MS);
  };
  ingest.onerror = (error) => {
    throw new Error(`ingest socket error: ${error && error.error ? error.error() : error}`);
  };
}
