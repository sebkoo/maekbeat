import { describe, expect, it } from "vitest";

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { packageVersion } from "./version";

const EXPECTED_PATHS = ["/devices", "/devices/{deviceId}/frames", "/healthz", "/ingest"];

describe("OpenAPI document", () => {
  it("lists exactly the C6 route surface", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.ready();

    const doc = app.swagger();
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(EXPECTED_PATHS);
    expect(doc.info.description).toContain("/ingest");
    expect(doc.info.version).toBe(packageVersion);
    expect("openapi" in doc && doc.openapi).toMatch(/^3\./);

    await app.close();
  });

  it("lists the same routes in development, with Swagger UI mounted", async () => {
    const devApp = await buildApp(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "silent" }));
    await devApp.ready();
    expect(Object.keys(devApp.swagger().paths ?? {}).sort()).toEqual(EXPECTED_PATHS);
    await devApp.close();
  });

  it("mounts Swagger UI in development only", async () => {
    const testApp = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    const missing = await testApp.inject({ method: "GET", url: "/docs" });
    expect(missing.statusCode).toBe(404);
    await testApp.close();

    const devApp = await buildApp(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "silent" }));
    const served = await devApp.inject({ method: "GET", url: "/docs" });
    expect([200, 302]).toContain(served.statusCode);
    await devApp.close();
  });
});
