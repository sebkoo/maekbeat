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
