/*
 * Captures docs/demo/preview.gif from the real system: a real apps/server, a
 * real production build of this dashboard, real vitals-sim frames over a real
 * WebSocket, and a real click on the acknowledgement control. Nothing here is
 * mocked or re-enacted — if the pipeline breaks, this script produces nothing.
 *
 *   pnpm --filter @maekbeat/web demo:gif
 *
 * Requires Chrome (driven headless through puppeteer-core, no browser
 * download) and ffmpeg (frames to GIF). Both are developer tools, not runtime
 * dependencies of anything this repo ships.
 *
 * Honesty, since a monitoring GIF invites exactly the wrong inference: the
 * numbers below are printed at the end of the run and belong in the caption.
 * The recording samples the page at a fixed wall-clock interval and plays back
 * at a fixed frame rate, so the ratio is arithmetic rather than a guess — and
 * nothing about the system's real latency can be read off the result.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { takeFrames } from "@maekbeat/vitals-sim";
import puppeteer from "puppeteer-core";
import { WebSocket } from "ws";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const OUT = join(REPO, "docs", "demo", "preview.gif");

/** macOS default; set CHROME_PATH to run this anywhere else. */
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_PORT = 3111;
const WEB_PORT = 4311;
const DEVICE_ID = "demo-001";

/** Device time per wall-clock second: the simulator's 1 s tick, sent every 100 ms. */
const TICK_SPACING_MS = 100;
const SIM_SPEED = 1_000 / TICK_SPACING_MS;
/** One captured frame per this much wall time. */
const SAMPLE_EVERY_MS = 500;
/** Frames per second in the finished GIF. */
const GIF_FPS = 10;
const PLAYBACK_SPEED = SAMPLE_EVERY_MS / (1_000 / GIF_FPS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: REPO, stdio: "inherit", ...options });
  child.on("error", (error) => {
    console.error(`capture: ${command} failed:`, error.message);
  });
  return child;
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const children = [];
const cleanup = async () => {
  for (const child of children) child.kill("SIGTERM");
};

async function main() {
  const workdir = await mkdtemp(join(tmpdir(), "maekbeat-gif-"));
  await mkdir(join(REPO, "docs", "demo"), { recursive: true });

  console.log("capture: building the dashboard");
  await new Promise((resolve, reject) => {
    const build = run("pnpm", ["--filter", "@maekbeat/web", "build"], {
      env: { ...process.env, VITE_API_BASE_URL: `http://127.0.0.1:${SERVER_PORT}` },
    });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
  });

  console.log("capture: starting apps/server");
  children.push(
    run("pnpm", ["--filter", "@maekbeat/server", "start"], {
      env: { ...process.env, PORT: String(SERVER_PORT), LOG_LEVEL: "warn" },
      stdio: "ignore",
    }),
  );
  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`);

  console.log("capture: serving the built dashboard");
  children.push(
    // --host pins IPv4: vite preview otherwise binds ::1 only, which the
    // headless browser and the readiness probe below cannot reach.
    run(
      "pnpm",
      [
        "--filter",
        "@maekbeat/web",
        "exec",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(WEB_PORT),
        "--strictPort",
      ],
      { stdio: "ignore" },
    ),
  );
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`);

  // Seed a little history so the chart has a line before recording starts.
  // startAtMs is set to now, so the on-screen drift signal starts near zero.
  // It still moves during the capture — 1 s of device time is replayed every
  // 100 ms, so receivedAtMs - capturedAtMs falls by 900 ms per frame. That is
  // the replay speed showing up in the drift readout, not a system latency.
  // The wall clock is consulted here, in capture configuration, never inside
  // generation, so the golden fixtures stay untouched.
  const frames = takeFrames(
    {
      scenario: "anomaly",
      seed: 7,
      deviceId: DEVICE_ID,
      startAtMs: Date.now(),
    },
    200,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ingest`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  let cursor = 0;
  const sendUpTo = async (target) => {
    for (; cursor < target && cursor < frames.length; cursor++) {
      socket.send(JSON.stringify(frames[cursor]));
      await sleep(TICK_SPACING_MS);
    }
  };
  console.log("capture: seeding 60 frames of history");
  await sendUpTo(60);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  // Tall enough for the whole device page, so clicking the acknowledgement
  // control never scrolls the view mid-recording.
  await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/devices/${DEVICE_ID}`, {
    waitUntil: "networkidle0",
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`page: ${message.text()}`);
  });
  try {
    await page.waitForSelector(".mb-chart__plot", { timeout: 15_000 });
  } catch (error) {
    console.error("capture: the page never rendered a chart. It showed:");
    console.error(await page.evaluate(() => document.body.innerText));
    throw error;
  }

  let shot = 0;
  const capture = async () => {
    await page.screenshot({
      path: join(workdir, `frame-${String(shot++).padStart(4, "0")}.png`),
      type: "png",
    });
  };

  // The desaturation begins around seq 85 and the engine raises near 100.
  // Frames stream for the whole recording, including through the
  // acknowledgement, so every captured frame advances device time and the
  // playback ratio below describes the whole GIF rather than part of it.
  console.log("capture: recording the anomaly");
  const firstSeq = cursor;
  const streaming = sendUpTo(frames.length);
  let acknowledged = false;

  for (let i = 0; i < 32; i++) {
    await capture();
    // Acknowledge partway through, without pausing the stream.
    if (!acknowledged && (await page.$("button[aria-label^='Acknowledge']")) !== null) {
      await page.click("button[aria-label^='Acknowledge']");
      acknowledged = true;
    }
    await sleep(SAMPLE_EVERY_MS);
  }
  const lastSeq = cursor;
  await streaming;

  if (!acknowledged) throw new Error("no alert was raised during the capture");
  await page.waitForSelector(".mb-timeline__decision");

  await browser.close();
  socket.close();

  console.log(`capture: encoding ${shot} frames to ${OUT}`);
  await new Promise((resolve, reject) => {
    const ffmpeg = run(
      "ffmpeg",
      [
        "-y",
        "-framerate",
        String(GIF_FPS),
        "-i",
        join(workdir, "frame-%04d.png"),
        "-vf",
        `fps=${GIF_FPS},scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        "-loop",
        "0",
        OUT,
      ],
      { stdio: "ignore" },
    );
    ffmpeg.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)),
    );
  });

  await rm(workdir, { recursive: true, force: true });

  // Measured from this run: how much device time the captured span actually
  // covered, over how long the GIF actually plays.
  const deviceSeconds = lastSeq - firstSeq;
  const gifSeconds = shot / GIF_FPS;
  const caption = [
    `${shot} frames sampled every ${SAMPLE_EVERY_MS} ms of wall time and played at ${GIF_FPS} fps (${gifSeconds.toFixed(1)} s)`,
    `playback is ${PLAYBACK_SPEED}x the capture`,
    `the simulator replays device time at ${SIM_SPEED}x`,
    `measured over this run: ${deviceSeconds} s of simulated device time in ${gifSeconds.toFixed(1)} s of GIF, about ${Math.round(deviceSeconds / gifSeconds)}x`,
  ].join("; ");
  await writeFile(join(REPO, "docs", "demo", "preview.caption.txt"), `${caption}\n`, "utf8");
  console.log(`capture: ${caption}`);
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("capture failed:", error);
    await cleanup();
    process.exit(1);
  });
