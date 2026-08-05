import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await buildApp(config);

// Graceful shutdown: SIGTERM is what an orchestrator (ECS task stop, planned —
// C19) sends before killing the task; SIGINT covers Ctrl-C in dev. app.close()
// stops accepting connections and lets in-flight requests finish.
function shutdown(signal: NodeJS.Signals): void {
  app.log.info({ signal }, "shutting down");
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    },
  );
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
