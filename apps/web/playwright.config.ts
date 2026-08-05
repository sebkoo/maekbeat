import { defineConfig, devices } from "@playwright/test";

/*
 * The smoke suite runs against what a visitor actually gets: a real Chromium,
 * the production bundle from `vite build` served as static files, a real
 * apps/server process, and a real cross-origin request between them.
 *
 * That combination is the point. C12 shipped a dashboard that could not reach
 * its own API from a browser — every suite mocked fetch, so nothing had ever
 * crossed an origin — and C12a shipped a retention rule that could have been
 * left unwired in buildApp with every server test still green. Both are the
 * same disease: nothing verified what the process runs. This file is the
 * mechanical cure for the web tier.
 *
 * Deliberately NOT here: the vite dev server (it proxies and transforms
 * differently from the bundle), any mock, and any fixture that stands in for a
 * real process.
 */

export const API_PORT = 3210;
export const WEB_PORT = 4210;
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Smoke, not suite: a handful of tests that must always be worth their
  // runtime. The boundary against unit tests is written down in README.md.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },

  /*
   * No retries, anywhere, including CI. A smoke test that quietly passes on the
   * second attempt reports a system that works when what it observed was a
   * system that failed and then worked — the same lie as a coverage badge left
   * quietly stale. If retries are ever introduced, `reporter` must be changed
   * with them so that failures-before-pass appear in the output rather than
   * being folded into a green tick.
   */
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Two real processes. The dashboard is built with the API's address baked in,
  // so the browser makes a genuine cross-origin request to a different port —
  // exactly the shape that was broken and undetected until C12.
  webServer: [
    {
      command: "pnpm --filter @maekbeat/server start",
      env: { PORT: String(API_PORT), LOG_LEVEL: "warn" },
      url: `${API_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @maekbeat/web build && pnpm --filter @maekbeat/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { VITE_API_BASE_URL: API_URL },
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
