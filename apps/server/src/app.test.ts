import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildApp } from "./app";
import { loadConfig } from "./config";

const quietEnv = { NODE_ENV: "test", LOG_LEVEL: "silent" };

describe("GET /healthz", () => {
  it("reports status, uptime, and the package.json version", async () => {
    const app = await buildApp(loadConfig(quietEnv));
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const body = response.json<{ status: string; uptimeSec: number; version: string }>();
    expect(body.status).toBe("ok");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe(manifest.version);

    await app.close();
  });
});

describe("central error handler", () => {
  it("masks 5xx details outside development", async () => {
    const app = await buildApp(loadConfig(quietEnv));
    app.get("/boom", () => {
      throw new Error("secret internal detail");
    });

    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ statusCode: 500, message: "Internal Server Error" });
    expect(response.body).not.toContain("secret internal detail");

    await app.close();
  });

  it("shows 5xx details in development", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "silent" }));
    app.get("/boom", () => {
      throw new Error("dev-visible detail");
    });

    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ statusCode: 500, message: "dev-visible detail" });

    await app.close();
  });

  it("passes through 4xx status codes and messages", async () => {
    const app = await buildApp(loadConfig(quietEnv));
    app.get("/teapot", () => {
      const error = new Error("short and stout") as Error & { statusCode: number };
      error.statusCode = 418;
      throw error;
    });

    const response = await app.inject({ method: "GET", url: "/teapot" });
    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({ statusCode: 418, message: "short and stout" });

    await app.close();
  });
});

describe("CORS", () => {
  // The dashboard is served from a different origin than this API in every
  // setup the repo documents, so a browser blocks every read unless the server
  // says otherwise. No test crossed an origin before C12 and the mocked-fetch
  // suites could not have caught it; the demo capture did.
  it("allows any origin by default, because the server is unauthenticated and synthetic", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));

    const response = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { origin: "http://127.0.0.1:5173" },
    });

    expect(response.statusCode).toBe(200);
    // origin:true reflects the caller's origin, which allows the read exactly
    // as "*" would while keeping the header specific.
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    await app.close();
  });

  it("answers the preflight a POST of a decision triggers", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/devices/dev-1/alerts/a1/decisions",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect([200, 204]).toContain(response.statusCode);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    await app.close();
  });

  it("honours an explicit allowlist and refuses an origin outside it", async () => {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        CORS_ORIGIN: "https://dash.example, https://ops.example",
      }),
    );

    const allowed = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { origin: "https://dash.example" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://dash.example");

    // The second entry carries a leading space, so the trim is load-bearing.
    const spaced = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { origin: "https://ops.example" },
    });
    expect(spaced.headers["access-control-allow-origin"]).toBe("https://ops.example");

    const refused = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { origin: "https://not-listed.example" },
    });
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
