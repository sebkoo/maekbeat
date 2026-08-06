import { describe, expect, it } from "vitest";

import { loadConfig, REQUIRED_PRODUCTION_ENV } from "./config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    expect(loadConfig({})).toEqual({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      RING_CAPACITY: 1024,
      CORS_ORIGIN: "*",
      STREAM_HEARTBEAT_MS: 25_000,
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
        STREAM_HEARTBEAT_MS: "30000",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.example:4318/v1/traces",
        OTEL_SERVICE_NAME: "maekbeat-server-eu",
        BUILD_REVISION: "0123abc",
      }),
    ).toEqual({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: 8080,
      LOG_LEVEL: "debug",
      RING_CAPACITY: 512,
      CORS_ORIGIN: "https://dash.example",
      STREAM_HEARTBEAT_MS: 30_000,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.example:4318/v1/traces",
      OTEL_SERVICE_NAME: "maekbeat-server-eu",
      BUILD_REVISION: "0123abc",
    });
  });

  describe("REQUIRED_PRODUCTION_ENV", () => {
    // The list is exported so infra/cdk can assert the task definition
    // supplies every entry (apps/server/package.json `exports`). That is only
    // worth anything if the list is the same one the server enforces, so this
    // iterates the object rather than naming its current single member: a key
    // added to it and not enforced fails here, and a key enforced by a
    // hand-written `if` outside it is a key the deployment never hears about.
    it("is exactly what loadConfig refuses to start without in production", () => {
      for (const [name, reason] of Object.entries(REQUIRED_PRODUCTION_ENV)) {
        expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(new RegExp(name));
        // The reason travels with the name, because "BUILD_REVISION: required"
        // tells an operator staring at a crash-looping container nothing they
        // did not already know.
        expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
          reason.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        );
      }
    });

    it("is not enforced outside production", () => {
      // Positive control. Without it the test above passes on a loadConfig
      // that rejects every environment, required list or not.
      for (const name of Object.keys(REQUIRED_PRODUCTION_ENV)) {
        expect(loadConfig({ NODE_ENV: "test" })).not.toHaveProperty(name);
      }
      expect(() => loadConfig({ NODE_ENV: "test" })).not.toThrow();
    });
  });

  describe("BUILD_REVISION", () => {
    // An image that cannot name its commit cannot be caught serving a stale
    // layer, which is the whole of criterion 5 in the C19 brief. Refusing to
    // start is the readable failure; starting and answering "unidentified" in
    // production would be the silent one.
    it("is required under NODE_ENV=production, and the error names it", () => {
      expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/BUILD_REVISION/);
    });

    it("rejects an empty value rather than treating it as absent", () => {
      // `docker run -e BUILD_REVISION= …` is how the variable is removed from
      // an image that bakes it, so empty has to fail the same way missing does.
      expect(() => loadConfig({ NODE_ENV: "production", BUILD_REVISION: "  " })).toThrow(
        /BUILD_REVISION/,
      );
    });

    it("is absent, not invented, outside production", () => {
      // Positive control for the two above: the same absence that fails in
      // production is fine here, so the rule is about the pair and not about
      // the variable always being set.
      expect(loadConfig({ NODE_ENV: "development" })).not.toHaveProperty("BUILD_REVISION");
      expect(loadConfig({ NODE_ENV: "test" }).BUILD_REVISION).toBeUndefined();
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
