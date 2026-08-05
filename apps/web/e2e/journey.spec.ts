import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { takeFrames } from "@maekbeat/vitals-sim";
import { WebSocket } from "ws";

import { API_URL } from "../playwright.config";

/*
 * One journey, end to end, through everything the process actually runs:
 *
 *   load the dashboard -> see the device -> open it -> watch frames arrive over
 *   the WebSocket -> see the alert appear -> acknowledge it -> reload -> the
 *   decision is still there.
 *
 * That single path crosses an origin (CORS), opens the fan-out socket, reads
 * REST, and proves the decision is server truth rather than component state.
 * Each of those was, at some point, verified by nothing.
 */

/**
 * One device per test. The server process is shared across the run — that is
 * the point of testing the real thing — so a device reused between tests would
 * carry the first test's alerts and decisions into the second.
 */
let deviceSeq = 0;
const nextDeviceId = () => `e2e-${String(++deviceSeq).padStart(3, "0")}`;

/** Streams simulator frames into the real server over a real socket. */
async function streamFrames(deviceId: string, count: number, startFrom = 0) {
  const socket = new WebSocket(`${API_URL.replace("http", "ws")}/ingest`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  // A recent epoch keeps the drift readout small; the sim's own tick spacing
  // is what makes the anomaly land where the engine expects it.
  const frames = takeFrames(
    { scenario: "anomaly", seed: 7, deviceId, startAtMs: START_AT_MS },
    startFrom + count,
  ).slice(startFrom);

  for (const frame of frames) {
    socket.send(JSON.stringify(frame));
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  socket.close();
}

const START_AT_MS = Date.now() - 400_000;

/** The dashboard's own text for the newest heart rate, as a number. */
async function latestHeartRate(page: Page): Promise<number> {
  const text = await page.locator(".mb-metric__value").first().innerText();
  return Number(text.replace(/[^\d.]/g, ""));
}

test.describe("the caregiver journey", () => {
  test("streams, alerts, acknowledges, and remembers across a reload", async ({ page }) => {
    const DEVICE_ID = nextDeviceId();
    // The anomaly's desaturation starts around seq 85; 80 frames is a device
    // that exists and is streaming, with no alert yet.
    await streamFrames(DEVICE_ID, 80);

    // 1. The dashboard loads and lists the device — a real cross-origin read.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Devices" })).toBeVisible();
    const deviceLink = page.getByRole("link", { name: DEVICE_ID });
    await expect(deviceLink).toBeVisible();

    // 2. Opening the device shows live vitals and a connected socket.
    await deviceLink.click();
    await expect(page.getByRole("heading", { level: 1, name: DEVICE_ID })).toBeVisible();
    await expect(page.locator(".mb-conn-badge")).toHaveText("live");
    await expect(page.locator(".mb-chart__plot").first()).toBeVisible();

    // 3. Frames pushed over the socket reach a page that is already open: the
    //    heart rate the page shows changes without a reload.
    const before = await latestHeartRate(page);
    await streamFrames(DEVICE_ID, 40, 80);
    await expect.poll(async () => latestHeartRate(page), { timeout: 15_000 }).not.toBe(before);

    // 4. The desaturation raises an alert, and it arrives as one episode.
    const timelineRow = page.locator(".mb-timeline__row").first();
    await expect(timelineRow).toBeVisible({ timeout: 15_000 });
    await expect(timelineRow).toContainText("spo2Pct low");
    await expect(page.locator(".mb-timeline__row")).toHaveCount(1);

    // 5. Acknowledging it is a real POST to a real route.
    await page
      .getByRole("button", { name: /^Acknowledge/ })
      .first()
      .click();
    await expect(page.locator(".mb-timeline__decision")).toContainText(
      "Acknowledged by web-dashboard",
    );

    // 6. The decision is server truth: it survives a reload, which throws away
    //    every piece of client state the page ever held.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: DEVICE_ID })).toBeVisible();
    await expect(page.locator(".mb-timeline__decision")).toContainText(
      "Acknowledged by web-dashboard",
    );
    await expect(page.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
  });

  test("says the connection is lost rather than showing a frozen screen", async ({
    page,
    context,
  }) => {
    const DEVICE_ID = nextDeviceId();
    await streamFrames(DEVICE_ID, 10);

    // Every call to the API fails, the way an unreachable server does. The
    // dashboard must say so — an empty chart frame and a silent page would be
    // indistinguishable from a device that is simply resting.
    await context.route(`${API_URL}/**`, (route) => route.abort());
    await page.goto(`/devices/${DEVICE_ID}`);

    await expect(page.getByRole("alert")).toContainText("Connection lost");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    // The line that must survive every failure path.
    await expect(page.getByText(/Not a medical device/)).toBeVisible();
  });
});

test.describe("accessibility, in a real engine", () => {
  // jsdom axe and browser axe are different instruments: colour contrast,
  // computed styles and focus behaviour only exist here. The C12 assertions are
  // re-run against the real thing so the WCAG 2.2 AA claim rests on it.
  test("the device page has no axe violations, contrast included", async ({ page }) => {
    const DEVICE_ID = nextDeviceId();
    await streamFrames(DEVICE_ID, 110);
    await page.goto(`/devices/${DEVICE_ID}`);
    await expect(page.locator(".mb-chart__plot").first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  test("acknowledges with the keyboard, and shows focus while doing it", async ({ page }) => {
    const DEVICE_ID = nextDeviceId();
    await streamFrames(DEVICE_ID, 110);
    await page.goto(`/devices/${DEVICE_ID}`);
    const acknowledge = page.getByRole("button", { name: /^Acknowledge/ }).first();
    await expect(acknowledge).toBeVisible({ timeout: 15_000 });

    // Tab until the control has focus — no clicking, no synthesised events.
    for (
      let i = 0;
      i < 40 && !(await acknowledge.evaluate((node) => node === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(acknowledge).toBeFocused();

    // The focus ring is a real computed style here, not a stylesheet claim.
    const outlineWidth = await acknowledge.evaluate((node) => getComputedStyle(node).outlineWidth);
    expect(Number.parseFloat(outlineWidth)).toBeGreaterThan(0);

    // WCAG 2.2 SC 2.5.8: the target's real box, not its declaration.
    const box = await acknowledge.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await page.keyboard.press("Enter");
    await expect(page.locator(".mb-timeline__decision")).toContainText("Acknowledged");
  });

  test("keeps the streaming chart out of every live region", async ({ page }) => {
    const DEVICE_ID = nextDeviceId();
    await streamFrames(DEVICE_ID, 60);
    await page.goto(`/devices/${DEVICE_ID}`);
    await expect(page.locator(".mb-chart__plot").first()).toBeVisible();

    const chartInLiveRegion = await page.evaluate(() => {
      const selector =
        '[aria-live],[role="alert"],[role="status"],[role="log"],[role="timer"],[role="marquee"],output';
      return [...document.querySelectorAll(".mb-chart__plot")].some(
        (chart) => chart.closest(selector) !== null,
      );
    });
    expect(chartInLiveRegion).toBe(false);
  });
});
