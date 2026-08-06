import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    expect(loadConfig({})).toEqual({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      RING_CAPACITY: 1024,
      CORS_ORIGIN: "*",
      // Tracing is off by default, and off is the absence of an endpoint
      // rather than a boolean beside one: there is no configuration in which
      // an endpoint is set and unused (src/tracing.ts).
      OTEL_SERVICE_NAME: "maekbeat-server",
    });
    expect(loadConfig({})).not.toHaveProperty("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  });

  it("applies overrides from the environment", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: "8080",
        LOG_LEVEL: "debug",
        RING_CAPACITY: "512",
        CORS_ORIGIN: "https://dash.example",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.example:4318/v1/traces",
        OTEL_SERVICE_NAME: "maekbeat-server-eu",
      }),
    ).toEqual({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: 8080,
      LOG_LEVEL: "debug",
      RING_CAPACITY: 512,
      CORS_ORIGIN: "https://dash.example",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.example:4318/v1/traces",
      OTEL_SERVICE_NAME: "maekbeat-server-eu",
    });
  });

  it("rejects an OTLP endpoint that is not a URL, naming the variable", () => {
    // A half-configured exporter is worse than none: the server would start,
    // look instrumented, and export nowhere.
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "collector:4318" })).toThrow(
      /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/,
    );
  });

  it("ignores unrelated environment variables", () => {
    const config = loadConfig({ PATH: "/usr/bin", PORT: "4000" });
    expect(config.PORT).toBe(4000);
    expect(config).not.toHaveProperty("PATH");
  });

  it.each([
    ["PORT", "not-a-port"],
    ["PORT", "0"],
    ["PORT", "70000"],
    ["PORT", "3000.5"],
    ["HOST", "   "],
    ["RING_CAPACITY", "0"],
    ["RING_CAPACITY", "not-a-number"],
    ["LOG_LEVEL", "loud"],
    ["NODE_ENV", "staging"],
  ])("rejects invalid %s=%s and names the variable in the error", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrowError(new RegExp(key));
  });
});
