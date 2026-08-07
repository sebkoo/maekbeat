import { describe, expect, it } from "vitest";

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { packageVersion } from "./version";

const EXPECTED_PATHS = [
  "/devices",
  "/devices/{deviceId}/alerts",
  "/devices/{deviceId}/alerts/{alertId}/decisions",
  "/devices/{deviceId}/frames",
  "/devices/{deviceId}/stream",
  "/healthz",
  "/ingest",
];

describe("OpenAPI document", () => {
  it("lists exactly the current route surface", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.ready();

    const doc = app.swagger();
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(EXPECTED_PATHS);
    expect(doc.info.description).toContain("/ingest");
    expect(doc.info.description).toContain("alert");
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

  /*
   * The page, not the route.
   *
   * @fastify/swagger-ui went from 5.2.6 to 6.1.1 — a major bump on a runtime
   * dependency — and merged green, because every assertion in this file was
   * about the OpenAPI document. app.swagger() is produced by @fastify/swagger,
   * a different package, so the whole UI could have shipped broken with this
   * file entirely satisfied. The case below it only asked whether /docs was
   * something other than a 404.
   *
   * A status code cannot see a blank screen. The UI is a static bundle that
   * boots into a mount point and then fetches its own spec, so this asserts all
   * three links in that chain against the running app: the page is HTML with
   * the mount point in it, every file the page asks for is served, and the spec
   * it fetches is this app's own document rather than a 404 the browser would
   * render as an empty page with a console error nobody sees.
   */
  it("serves a Swagger UI page whose assets and spec all resolve", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "silent" }));
    await app.ready();

    const page = await app.inject({ method: "GET", url: "/docs" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    // The element swagger-ui-bundle.js writes into. A 200 carrying an error
    // page or an empty body passes a status check and renders nothing.
    expect(page.body).toContain('id="swagger-ui"');

    // Read out of the page rather than listed here: a bundle that renames or
    // adds a file must stay served, and a hard-coded list would go on asserting
    // the old names while the new ones 404.
    const referenced = [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    // The count is the positive control. If the markup ever stops carrying
    // asset references, the loop below passes by having nothing to check.
    expect(referenced.length).toBeGreaterThanOrEqual(5);
    expect(referenced.filter((url) => url.endsWith(".js")).length).toBeGreaterThan(0);

    for (const url of referenced) {
      const asset = await app.inject({ method: "GET", url });
      expect(asset.statusCode, `asset referenced by the /docs page: ${url}`).toBe(200);
    }

    // The last link: the bundle fetches ./json relative to the page, and an
    // empty Swagger UI looks exactly like a working one until you read it.
    const spec = await app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    expect(Object.keys((spec.json() as { paths?: object }).paths ?? {}).sort()).toEqual(
      EXPECTED_PATHS,
    );

    await app.close();
  });

  // Kept for the half above does not cover: that no UI is mounted outside
  // development. The dev branch here is a mount check, not a render check.
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
