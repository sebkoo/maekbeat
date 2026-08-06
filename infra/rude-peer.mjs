/*
 * A WebSocket client that completes the handshake and then refuses to leave.
 *
 * The polite case is already proven: apps/server/src/tracing.lifecycle.test.ts
 * spawns a server with a client attached, sends SIGTERM, and the process is
 * gone in milliseconds. That test passes because the `ws` client answers the
 * server's close frame — the client does the work, and the server is credited
 * for it.
 *
 * This peer answers nothing. It speaks the opening handshake by hand over a
 * raw TCP socket and then never sends another byte: no close frame, no pong,
 * no FIN. In a container that is not a rude edge case but the ordinary shape
 * of a dropped mobile network, and the consequence is specific — the stop
 * hangs until the orchestrator's SIGKILL, which discards the tracing flush C18
 * exists for and reports exit 137 to whatever is watching the deployment.
 *
 *   node infra/rude-peer.mjs 127.0.0.1 3000
 *
 * Prints `attached` once the server has answered 101, then holds. Prints
 * `destroyed by peer` and exits 0 when the server ends the connection, which
 * is the behaviour infra/compose-smoke.sh is there to require.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 3000);

const socket = connect(port, host, () => {
  socket.write(
    [
      "GET /ingest HTTP/1.1",
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

socket.once("data", (chunk) => {
  if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) {
    console.error(`handshake refused: ${chunk.toString("latin1").split("\r\n")[0]}`);
    process.exit(1);
  }
  upgraded = true;
  console.log("attached");
  // Every later frame the server sends — including its close frame — is read
  // and dropped on the floor. Reading rather than pausing the socket matters:
  // a paused socket would fill the server's send buffer and turn this into a
  // backpressure test, which is a different fault with a different fix.
  socket.on("data", () => {});
  // Holds the event loop open. Without it the process would exit on its own
  // and close the connection politely, which is precisely what it must not do.
  setInterval(() => {}, 1_000);
});

socket.on("close", () => {
  console.log(upgraded ? "destroyed by peer" : "closed before upgrade");
  process.exit(0);
});

socket.on("error", (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});
