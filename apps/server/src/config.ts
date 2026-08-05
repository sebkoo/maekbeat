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
});

export type ServerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment — ${issues}`);
  }
  return parsed.data;
}
