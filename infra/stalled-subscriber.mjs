/*
 * A dashboard that subscribes to the fan-out and then stops reading.
 *
 * The sibling of infra/rude-peer.mjs, and deliberately its opposite. That peer
 * reads every byte and discards it, so the server's close frame is consumed and
 * the shutdown case stays away from backpressure. This one pauses its socket
 * after the handshake, so the kernel's receive buffer fills, then the server's
 * send queue does — which is the condition apps/server/src/stream.ts bounds at
 * STREAM_MAX_BUFFERED_BYTES and answers by dropping the subscriber.
 *
 *   node infra/stalled-subscriber.mjs 127.0.0.1 3000 k6-fanout-0
 *
 * Prints `attached` once the server answers 101, then holds and reads nothing.
 * Prints `dropped by server` and exits 0 when the server ends the connection,
 * which is what infra/load.sh times to measure what a stalled subscriber costs
 * the healthy ones.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 3000);
const deviceId = process.argv[4] ?? "k6-fanout-0";

const socket = connect(port, host, () => {
  socket.write(
    [
      `GET /devices/${deviceId}/stream HTTP/1.1`,
      `Host: ${host}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
});

let upgraded = false;
const startedAt = Date.now();

socket.once("data", (chunk) => {
  const status = chunk.toString("latin1").split("\r\n")[0] ?? "";
  if (!status.startsWith("HTTP/1.1 101")) {
    console.error(`handshake refused: ${status}`);
    process.exit(1);
  }
  upgraded = true;
  console.log("attached");
  // The stall itself. Nothing is read from here on, so everything the server
  // publishes for this device queues — first in the socket's receive buffer,
  // then in the server's own write queue, which is the thing being measured.
  socket.pause();
  // Holds the event loop open without reading a byte.
  setInterval(() => {}, 1_000);
});

socket.on("close", () => {
  console.log(
    upgraded ? `dropped by server after ${Date.now() - startedAt} ms` : "closed before upgrade",
  );
  process.exit(0);
});

socket.on("error", (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});
