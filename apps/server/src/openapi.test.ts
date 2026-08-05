import { describe, expect, it } from "vitest";

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { packageVersion } from "./version";

describe("OpenAPI document", () => {
  it("lists exactly /healthz", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.ready();

    const doc = app.swagger();
    expect(Object.keys(doc.paths ?? {})).toEqual(["/healthz"]);
    expect(doc.info.version).toBe(packageVersion);
    expect("openapi" in doc && doc.openapi).toMatch(/^3\./);

    await app.close();
  });

  it("lists exactly /healthz in development too, with Swagger UI mounted", async () => {
    const devApp = await buildApp(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "silent" }));
    await devApp.ready();
    expect(Object.keys(devApp.swagger().paths ?? {})).toEqual(["/healthz"]);
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
