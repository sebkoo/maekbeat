import { z } from "zod";

import { DEVICE_SILENCE_MS_DEFAULT } from "./silence";
import { STREAM_HEARTBEAT_MS_DEFAULT } from "./stream";

/**
 * Environment contract for the server. Unknown variables are ignored, missing
 * ones fall back to the defaults below, and invalid values fail startup with
 * the offending variable named. .env.example documents each entry.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Max frames retained per device in the ring buffer (oldest arrival evicted). */
  RING_CAPACITY: z.coerce.number().int().min(1).max(65536).default(1024),
  /**
   * Browser origins allowed to read this API: `*`, or a comma-separated
   * allowlist. The dashboard is served from a different origin than the API in
   * every setup this repo documents — vite on :5173, the server on :3000 — so
   * without this the browser blocks every read. The default is permissive
   * because the server is unauthenticated and holds only synthetic data
   * (README, "Declared limits"); a deployment with real origins sets the list.
   */
  CORS_ORIGIN: z.string().trim().min(1).default("*"),
  /**
   * Maximum silence on a dashboard fan-out socket before the server sends a
   * WebSocket ping (src/stream.ts). Configurable because the value that
   * matters is a property of whatever sits between the server and the browser
   * rather than of the server, and every deployment has a different one; the
   * default assumes the 60-second idle timeout that both AWS load balancers
   * and nginx ship with. The ceiling is 300 s because a keepalive slower than
   * that beats no intermediary default this repository knows of, and the
   * floor is 1 s because zero would mean a ping per event-loop turn rather
   * than "off" — there is no off, since a fan-out socket with no keepalive is
   * the bug this variable exists to prevent.
   */
  STREAM_HEARTBEAT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(STREAM_HEARTBEAT_MS_DEFAULT),
  /**
   * Maximum silence from a DEVICE before the server raises an alarm about it
   * (src/silence.ts). The heartbeat above proves the socket; this judges the
   * sensor, and until C20a nothing did — from the fan-out layer a calm patient
   * and a dead link looked identical.
   *
   * Configurable because the value that matters is a property of the gateway
   * and the link in front of this server rather than of the server: the
   * default is derived from apps/ios's own reconnect deadlines, and a
   * deployment whose devices report at a different cadence, or reconnect on
   * different timings, has a different right answer.
   *
   * The floor is 5 s because the fastest cadence this repository documents is
   * the simulator's 1 Hz, so five seconds is five consecutive missed frames —
   * the tightest value that is about silence rather than jitter. The ceiling
   * is one hour because past that the alarm is not monitoring. What the
   * bounds cannot check is the judgement: this schema does not know the
   * deployment's reconnect window, so a value below it parses here and is
   * wrong there, which is why the default's basis is written down in
   * src/silence.ts and pinned by a test rather than asserted in prose.
   */
  DEVICE_SILENCE_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(3_600_000)
    .default(DEVICE_SILENCE_MS_DEFAULT),
  /**
   * OTLP/HTTP traces endpoint. Its presence is the entire on switch: unset,
   * the server builds no exporter, no span processor and no batch timer, and
   * every span it starts is non-recording (src/tracing.ts). The name is the
   * OpenTelemetry standard one so an operator can reuse what they already
   * know, but it is declared here like every other variable — the environment
   * contract stays one schema, never half here and half inside an SDK.
   *
   * The scheme is checked explicitly rather than by URL parsing alone:
   * `new URL("collector:4318")` parses happily — scheme "collector", path
   * "4318" — so a bare host:port would start a server that looks instrumented
   * and exports to nowhere. The test is case-insensitive because URL schemes
   * are, and rejecting `HTTPS://` would be rejecting a valid endpoint.
   */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z
    .string()
    .trim()
    .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), {
      message: "must be an http(s) URL, e.g. http://collector:4318/v1/traces",
    })
    .optional(),
  /** Resource `service.name` on every exported span. */
  OTEL_SERVICE_NAME: z.string().trim().min(1).default("maekbeat-server"),
  /**
   * The commit this build was made from, served on /healthz and stamped on the
   * image as `org.opencontainers.image.revision` (infra/server.Dockerfile).
   * The two come from one build argument, so a container that answers with a
   * revision its own label does not carry is a container running something
   * other than what was built — which is the check infra/compose-smoke.sh
   * makes, and the reason this variable exists at all.
   *
   * Required under NODE_ENV=production and absent by default everywhere else.
   * A developer checkout is a working tree rather than a commit, and making it
   * claim a SHA would be inventing the one fact this variable is for; a
   * production image that cannot name its commit is the C13 stale-bundle
   * failure with no way left to detect it, so there it is a startup error
   * (checked in loadConfig below, not by the schema, because the requirement
   * is a relation between two variables rather than a property of one).
   */
  BUILD_REVISION: z
    .string()
    .trim()
    .min(1, "must name the commit this build came from, e.g. the output of `git rev-parse HEAD`")
    .optional(),
});

export type ServerConfig = z.infer<typeof envSchema>;

/** Reported by /healthz when nothing told the process which commit it is. */
export const UNIDENTIFIED_REVISION = "unidentified";

/**
 * The variables this server refuses to start without under
 * `NODE_ENV=production`, each with the message it fails with.
 *
 * Every other entry in the schema above has a default, so "required" here
 * means something narrower and more useful than "declared": these are the
 * values a deployment has to supply because the process cannot invent them.
 * The check below is driven by this object rather than by a hand-written `if`
 * per variable, which is what makes the list mean anything — a variable added
 * here starts being enforced, and one removed stops.
 *
 * It is exported because something outside this process has to satisfy it, and
 * until now every one of those places restated the requirement in its own
 * words: infra/server.Dockerfile, infra/compose.yaml, infra/verify-image.sh and
 * the CDK task definition each named `BUILD_REVISION` independently. That is
 * one list written five times, and a sixth required variable would be enforced
 * at startup and wired nowhere — the container would fail to start in whatever
 * environment noticed first. infra/cdk reads this object and asserts the
 * synthesized task definition supplies every key in it, so the wiring fails a
 * test here instead of a deployment there.
 */
export const REQUIRED_PRODUCTION_ENV = {
  BUILD_REVISION:
    "required when NODE_ENV=production; set it to the commit the build came from " +
    "(infra/server.Dockerfile passes it as a build argument)",
} as const satisfies Partial<Record<keyof ServerConfig, string>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment — ${issues}`);
  }
  const config = parsed.data;
  // Checked here rather than in the schema because each is a relation between
  // two variables — this one and NODE_ENV — rather than a property of one.
  if (config.NODE_ENV === "production") {
    for (const [name, reason] of Object.entries(REQUIRED_PRODUCTION_ENV)) {
      if (config[name as keyof ServerConfig] === undefined) {
        throw new Error(`Invalid server environment — ${name}: ${reason}`);
      }
    }
  }
  return config;
}
