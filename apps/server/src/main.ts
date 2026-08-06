import { buildApp } from "./app";
import { loadConfig } from "./config";
import { installShutdownHandlers } from "./lifecycle";
import { startTracing } from "./tracing";

const config = loadConfig();
// Off unless OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set: no exporter, no batch
// processor, no timer, and every span non-recording (src/tracing.ts).
const tracing = startTracing(config);
const app = await buildApp(config, { tracer: tracing.tracer });

installShutdownHandlers(app, tracing, process, process.exit);

try {
  // The bound address, and whether tracing is on, on one line: "where is this
  // listening" and "is it exporting spans" are both questions asked at the
  // worst possible moment. It is also the readiness signal a harness can wait
  // on (src/tracing.lifecycle.test.ts) without polling an endpoint.
  const address = await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ tracing: tracing.enabled, address }, "started");
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
