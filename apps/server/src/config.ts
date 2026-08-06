import { z } from "zod";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment — ${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production" && config.BUILD_REVISION === undefined) {
    throw new Error(
      "Invalid server environment — BUILD_REVISION: required when NODE_ENV=production; " +
        "set it to the commit the build came from (infra/server.Dockerfile passes it as a build argument)",
    );
  }
  return config;
}
