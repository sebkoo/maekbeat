import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import type { VitalsFrame } from "@maekbeat/protocol";
import type { Tracer } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import fastifyWebsocket from "@fastify/websocket";
import { fastify } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { AlertEngine } from "./alerts";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { INGEST_MAX_PAYLOAD_BYTES, ingestPlugin } from "./ingest";
import { VitalsStore } from "./store";
import { SPAN_ATTRIBUTES, SPAN_NAMES } from "./tracing";

/*
 * The proof this commit exists for.
 *
 * A span that exists is not a span that is linked. Every assertion about the
 * tree below reads `parentSpanContext.spanId` and compares it to a spanId
 * taken from another span in the same batch — never a name, never a count.
 * Names are unstable under refactor and counting proves only arithmetic; an
 * integration that emits six correctly-named roots per frame passes both and
 * tells an operator nothing at 3am, which is the failure mode.
 *
 * The oracle is packages/vitals-sim/golden/anomaly.ndjson — the same bytes the
 * TypeScript golden gate and the Swift decode tests read, replayed through a
 * real WebSocket into a real server, so what is traced is the shipped ingest
 * path rather than a harness that resembles it.
 */

const GOLDEN = new URL("../../../packages/vitals-sim/golden/anomaly.ndjson", import.meta.url);
const DEVICE_ID = "sim-001";

/** The fixture's frames, without its header line. */
function goldenFrames(): VitalsFrame[] {
  return readFileSync(GOLDEN, "utf8")
    .split("\n")
    .slice(1, -1)
    .map((line) => JSON.parse(line) as VitalsFrame);
}

/**
 * A receive clock that advances one second per frame, matching the simulator's
 * tick. Injected rather than read from the wall clock so the traced and
 * untraced replays below produce the same receive stamps — without it, every
 * timestamp, and therefore every alertId, differs between two runs whether or
 * not tracing is involved, and the comparison that proves instrumentation
 * changes nothing would be comparing normalised output instead of bytes.
 */
function fixedClock(): () => number {
  let ms = 1_754_265_600_000;
  return () => (ms += 1_000);
}

interface Ack {
  type: string;
  deviceId?: string;
  seq?: number;
  sessionEpoch?: number;
  reason?: string;
}

function sendAndAwaitReply(socket: WebSocket, payload: string): Promise<Ack> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      cleanup();
      resolve(JSON.parse(String(data)) as Ack);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed (${code}) while awaiting a reply`));
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
    socket.send(payload);
  });
}

interface Replay {
  close: () => Promise<void>;
  spans: ReadableSpan[];
  acks: Ack[];
  alertsBody: string;
}

/**
 * Builds a server, replays `frames` into it over a real /ingest socket, and
 * returns the finished spans plus the alert history it produced.
 *
 * `traced: false` passes no tracer and takes ingestPlugin's own fallback. That
 * is not byte-for-byte the production path — src/main.ts always passes the
 * tracer `startTracing` built — but both end at the same place: a provider
 * with `AlwaysOffSampler` and no span processor. Worth stating precisely
 * rather than claiming they are the same call.
 */
async function replay(frames: VitalsFrame[], traced: boolean): Promise<Replay> {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    // Simple, not batched: it exports on span end, so a test never waits on a
    // flush timer and never races one.
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer: Tracer | undefined = traced ? provider.getTracer("test") : undefined;

  const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {
    tracer,
    now: fixedClock(),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const acks: Ack[] = [];
  for (const frame of frames) {
    acks.push(await sendAndAwaitReply(ws, JSON.stringify(frame)));
  }

  const alerts = await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` });
  const result: Replay = {
    spans: exporter.getFinishedSpans(),
    acks,
    alertsBody: alerts.body,
    close: async () => {
      ws.close();
      await app.close();
      await provider.shutdown();
    },
  };
  return result;
}

const parentOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;
const idOf = (span: ReadableSpan): string => span.spanContext().spanId;
const named = (spans: ReadableSpan[], name: string): ReadableSpan[] =>
  spans.filter((s) => s.name === name);

describe("trace shape over the anomaly golden replay", () => {
  const frames = goldenFrames();
  let run: Replay;

  beforeAll(async () => {
    run = await replay(frames, true);
  }, 30_000);

  afterAll(async () => {
    await run.close();
  });

  it("replays the fixture into one raised and one resolved alert", () => {
    // The trace is only worth asserting if the run underneath it did the work.
    expect(run.acks).toHaveLength(frames.length);
    expect(run.acks.every((a) => a.type === "ack")).toBe(true);
    const states = named(run.spans, SPAN_NAMES.transition).map(
      (s) => s.attributes[SPAN_ATTRIBUTES.alertState],
    );
    expect(states).toEqual(["raised", "resolved"]);
  });

  it("opens exactly one ingest span per frame, each its own root", () => {
    const ingest = named(run.spans, SPAN_NAMES.ingest);
    expect(ingest).toHaveLength(frames.length);
    // Rooted deliberately: nothing upstream propagates trace context, so a
    // parent here would be invented. Every OTHER span must have one.
    expect(ingest.every((s) => parentOf(s) === undefined)).toBe(true);
    expect(run.spans.filter((s) => parentOf(s) === undefined)).toHaveLength(frames.length);
  });

  it("gives each ingest span exactly one validate, store, evaluate and fan-out child", () => {
    // "The parent is an ingest span" is not the property worth having — one
    // sticky context would parent all 480 children onto frame 0 and still
    // satisfy it. Counting children per parent is what pins the mapping to
    // one-to-one.
    //
    // Comparing the child's traceId to its parent's would add nothing at all:
    // the SDK derives a child's traceId FROM the parent context it was given,
    // so that equality holds by construction and can never fail. It is a
    // tautology, not a check, and it is deliberately absent here.
    const ingest = named(run.spans, SPAN_NAMES.ingest);
    const byParent = new Map<string, string[]>(ingest.map((s) => [idOf(s), []]));

    for (const span of run.spans) {
      const parentId = parentOf(span);
      if (parentId === undefined || !byParent.has(parentId)) continue;
      (byParent.get(parentId) as string[]).push(span.name);
    }

    for (const [, childNames] of byParent) {
      expect([...childNames].sort()).toEqual(
        [SPAN_NAMES.validate, SPAN_NAMES.store, SPAN_NAMES.evaluate, SPAN_NAMES.fanout].sort(),
      );
    }
  });

  it("roots each frame's whole subtree at that frame's own ingest span", () => {
    // The assertion that pins a child to the RIGHT frame rather than merely to
    // a well-formed one. Per-parent child counts (above) catch one sticky
    // context parenting everything onto frame 0; they do not catch a swap
    // between two neighbouring frames, which leaves every count intact.
    //
    // The handler is synchronous and the client awaits each ack, so one frame
    // is fully processed before the next message is read, and the exporter —
    // which receives spans as they end — emits one contiguous block per frame
    // terminated by that frame's ingest span. Walking the parent chain of every
    // span in a block must reach that block's ingest span and no other.
    //
    // Span timestamps are deliberately NOT used for this. The SDK derives
    // endTime as startTime plus elapsed time through two separate clock
    // conversions with a per-span offset, and the resulting jitter is around a
    // millisecond — larger than these spans — so a containment check on times
    // measures the clock rather than the tree, and would flake.
    const byId = new Map(run.spans.map((s) => [idOf(s), s]));
    const rootOf = (span: ReadableSpan): ReadableSpan => {
      let current = span;
      for (let hops = 0; hops < 8; hops++) {
        const parent = byId.get(parentOf(current) ?? "");
        if (parent === undefined) return current;
        current = parent;
      }
      throw new Error("parent chain did not terminate — a cycle in the trace");
    };

    let block: ReadableSpan[] = [];
    let blocks = 0;
    for (const span of run.spans) {
      block.push(span);
      if (span.name !== SPAN_NAMES.ingest) continue;

      // The block closed: every span in it belongs to this ingest span.
      for (const member of block) {
        expect(idOf(rootOf(member))).toBe(idOf(span));
      }
      blocks += 1;
      block = [];
    }
    expect(blocks).toBe(frames.length);
    // Nothing trailing after the last ingest span.
    expect(block).toEqual([]);
  });

  it("parents each alert transition on the evaluation that produced it, not on ingest", () => {
    const transitions = named(run.spans, SPAN_NAMES.transition);
    expect(transitions.length).toBeGreaterThan(0);

    const evaluateById = new Map(named(run.spans, SPAN_NAMES.evaluate).map((s) => [idOf(s), s]));
    const ingestIds = new Set(named(run.spans, SPAN_NAMES.ingest).map(idOf));

    for (const transition of transitions) {
      const parentId = parentOf(transition) as string;
      // A grandchild. Flattening this onto the ingest span would still produce
      // a linked trace and would still pass a "has a parent" check, so the
      // assertion is that the parent is the evaluation AND is not the root.
      expect(evaluateById.has(parentId)).toBe(true);
      expect(ingestIds.has(parentId)).toBe(false);

      const evaluate = evaluateById.get(parentId) as ReadableSpan;
      const grandparentId = parentOf(evaluate) as string;
      expect(ingestIds.has(grandparentId)).toBe(true);
      expect(transition.spanContext().traceId).toBe(evaluate.spanContext().traceId);
    }
  });

  it("counts its own children: the evaluation's transition count is the children it has", () => {
    for (const evaluate of named(run.spans, SPAN_NAMES.evaluate)) {
      const mine = named(run.spans, SPAN_NAMES.transition).filter(
        (t) => parentOf(t) === idOf(evaluate),
      );
      expect(evaluate.attributes[SPAN_ATTRIBUTES.transitionCount]).toBe(mine.length);
    }
  });

  it("gives every ingest span a distinct trace, which is what makes parentage checkable", () => {
    // The parentage assertions above conclude "this child's parent is THIS
    // ingest span" from a matching trace id. That inference is only valid if no
    // two ingest spans share a trace id, so it is asserted rather than assumed.
    const traceIds = named(run.spans, SPAN_NAMES.ingest).map((s) => s.spanContext().traceId);
    expect(new Set(traceIds).size).toBe(traceIds.length);
  });

  it("carries the frame's identifiers on the ingest span it belongs to", () => {
    // Keyed by seq rather than by array position: the exporter returns spans in
    // end order, and relying on that to mean "frame index" would be an
    // assumption doing the work of an assertion.
    const bySeq = new Map(
      named(run.spans, SPAN_NAMES.ingest).map((s) => [s.attributes[SPAN_ATTRIBUTES.seq], s]),
    );
    expect(bySeq.size).toBe(frames.length);

    for (const frame of frames) {
      const span = bySeq.get(frame.seq);
      expect(span).toBeDefined();
      const attrs = (span as ReadableSpan).attributes;
      expect(attrs[SPAN_ATTRIBUTES.deviceId]).toBe(frame.deviceId);
      expect(attrs[SPAN_ATTRIBUTES.ingestOutcome]).toBe("accepted");
      expect(attrs[SPAN_ATTRIBUTES.sessionEpoch]).toBe(1);
      // Only the frame that opened the session says so.
      expect(attrs[SPAN_ATTRIBUTES.newSession]).toBe(frame.seq === 0);
    }
  });

  it("carries alertId, lifecycle state and metric on the transition spans", () => {
    const transitions = named(run.spans, SPAN_NAMES.transition);
    const raised = transitions[0] as ReadableSpan;
    const resolved = transitions[1] as ReadableSpan;

    // Cross-checked against the REST alert history rather than against the
    // span's own shape: a prefix test would pass for any well-formed spo2-low
    // id, including one belonging to a different episode. The alertId a
    // responder pastes into a query has to be the alertId the API serves.
    const served = (JSON.parse(run.alertsBody) as { alerts: { alertId: string; state: string }[] })
      .alerts;
    expect(served).toHaveLength(1);
    const alertId = served[0]?.alertId;
    expect(String(alertId).startsWith(`${DEVICE_ID}:spo2-low:`)).toBe(true);
    expect(raised.attributes[SPAN_ATTRIBUTES.alertId]).toBe(alertId);
    // One episode: the raise and its resolution name the same alert, which is
    // what makes carrying the id worth anything.
    expect(resolved.attributes[SPAN_ATTRIBUTES.alertId]).toBe(alertId);

    expect(raised.attributes[SPAN_ATTRIBUTES.alertState]).toBe("raised");
    expect(resolved.attributes[SPAN_ATTRIBUTES.alertState]).toBe("resolved");
    for (const span of transitions) {
      expect(span.attributes[SPAN_ATTRIBUTES.alertMetric]).toBe("spo2Pct");
      expect(span.attributes[SPAN_ATTRIBUTES.alertDirection]).toBe("low");
    }
  });

  it("declares every attribute key it emits", () => {
    const declared = new Set<string>(Object.values(SPAN_ATTRIBUTES));
    const emitted = new Set<string>();
    for (const span of run.spans) {
      for (const key of Object.keys(span.attributes)) emitted.add(key);
    }
    expect(emitted.size).toBeGreaterThan(0);
    // An attribute that is not in src/tracing.ts fails here. That friction is
    // the control: adding a span attribute to this server is a decision about
    // what leaves the process, not an incidental edit.
    expect([...emitted].filter((key) => !declared.has(key))).toEqual([]);
  });

  it("names no vitals channel in any attribute key", () => {
    const forbidden = /heart|spo2|respir|motion|bpm|vital|reading|value/i;
    for (const span of run.spans) {
      for (const key of Object.keys(span.attributes)) {
        expect(key).not.toMatch(forbidden);
      }
    }
  });

  it("carries no reading value: every numeric attribute on every span is accounted for", () => {
    // "Identifiers, never readings", enforced as a total function rather than
    // as a checklist.
    //
    // A checklist is not enough here, and the reason is specific. Of the four
    // vitals channels, three are almost always fractional in this fixture —
    // SpO2 97.5, respiration 13.7, motion 0.003 — so a shape rule ("numeric
    // attributes are non-negative integers") catches them. Heart rate is an
    // integer in all 120 frames and slides straight through that rule. So the
    // assertion below is exact equality over the COMPLETE set of numeric
    // attributes each span carries: an unpinned numeric anywhere — a heart rate
    // written into `seq` on the validate span, or into `message_count` on the
    // ingest span — is an unexpected key or a wrong value, and fails. A gate
    // that only listed the pairs it expected to see would leave a hole exactly
    // the width of one vitals channel.
    const numericAttrs = (span: ReadableSpan): Record<string, number> =>
      Object.fromEntries(
        Object.entries(span.attributes).filter(([, v]) => typeof v === "number"),
      ) as Record<string, number>;

    const transitionCountOf = (parentId: string | undefined): number =>
      (named(run.spans, SPAN_NAMES.evaluate).find((e) => parentOf(e) === parentId)?.attributes[
        SPAN_ATTRIBUTES.transitionCount
      ] as number) ?? -1;

    const seqsSeen: number[] = [];
    for (const span of run.spans) {
      const actual = numericAttrs(span);
      switch (span.name) {
        case SPAN_NAMES.ingest: {
          const seq = actual[SPAN_ATTRIBUTES.seq];
          seqsSeen.push(seq as number);
          expect(actual).toEqual({
            [SPAN_ATTRIBUTES.seq]: seq,
            [SPAN_ATTRIBUTES.sessionEpoch]: 1,
          });
          break;
        }
        // No numeric attribute belongs on these at all.
        case SPAN_NAMES.validate:
        case SPAN_NAMES.transition:
          expect(actual).toEqual({});
          break;
        case SPAN_NAMES.store:
          expect(actual).toEqual({ [SPAN_ATTRIBUTES.sessionEpoch]: 1 });
          break;
        case SPAN_NAMES.evaluate:
          // Already tied to the span's own children by the count test above.
          expect(Object.keys(actual)).toEqual([SPAN_ATTRIBUTES.transitionCount]);
          break;
        case SPAN_NAMES.fanout:
          // No dashboard is attached, so fan-out reaches nobody and publishes
          // one frame message plus one per transition of the same frame.
          expect(actual).toEqual({
            [SPAN_ATTRIBUTES.subscriberCount]: 0,
            [SPAN_ATTRIBUTES.messageCount]: 1 + transitionCountOf(parentOf(span)),
          });
          break;
        default:
          throw new Error(`unexpected span name: ${span.name}`);
      }
    }

    // The one value left free above: every seq the fixture sent appears exactly
    // once, so no ingest span holds a number that is merely plausible.
    expect([...seqsSeen].sort((a, b) => a - b)).toEqual(frames.map((f) => f.seq));
  });
});

describe("the ingest span reports how the frame arrived", () => {
  // Golden frames, re-sequenced: the fixture is strictly monotonic, so the
  // arrival behaviour an operator squints at during an incident — a retransmit,
  // a frame that overtook another — does not occur in it. The payloads stay
  // the fixture's; only `seq` moves, which is the field the behaviour is about.
  const source = goldenFrames();
  const at = (index: number, seq: number): VitalsFrame => ({
    ...(source[index] as VitalsFrame),
    seq,
  });
  let run: Replay;

  beforeAll(async () => {
    run = await replay(
      [
        at(0, 0), // opens the session
        at(1, 1),
        at(2, 5), // a gap: 2..4 have not arrived
        at(3, 3), // late, inside the reorder window — accepted, out of order
        at(4, 3), // the same seq again — a duplicate, still out of order
        at(5, 5), // a retransmit of the highest seq — duplicate, in order
      ],
      true,
    );
  }, 30_000);

  afterAll(async () => {
    await run.close();
  });

  it("flags duplicate and out-of-order arrivals independently", () => {
    const ingest = named(run.spans, SPAN_NAMES.ingest);
    const arrival = ingest.map((span) => ({
      seq: span.attributes[SPAN_ATTRIBUTES.seq],
      duplicate: span.attributes[SPAN_ATTRIBUTES.duplicate],
      outOfOrder: span.attributes[SPAN_ATTRIBUTES.outOfOrder],
      outcome: span.attributes[SPAN_ATTRIBUTES.ingestOutcome],
    }));

    expect(arrival).toEqual([
      { seq: 0, duplicate: false, outOfOrder: false, outcome: "accepted" },
      { seq: 1, duplicate: false, outOfOrder: false, outcome: "accepted" },
      { seq: 5, duplicate: false, outOfOrder: false, outcome: "accepted" },
      { seq: 3, duplicate: false, outOfOrder: true, outcome: "accepted" },
      { seq: 3, duplicate: true, outOfOrder: true, outcome: "duplicate" },
      { seq: 5, duplicate: true, outOfOrder: false, outcome: "duplicate" },
    ]);
  });

  it("gives a duplicate no evaluation and no fan-out, and says so in the tree", () => {
    // A deduped frame never reaches the engine, so the trace must show the
    // path stopping — two ingest spans with a store child and nothing after.
    const ingest = named(run.spans, SPAN_NAMES.ingest);
    const duplicates = ingest.filter((s) => s.attributes[SPAN_ATTRIBUTES.duplicate] === true);
    expect(duplicates).toHaveLength(2);

    const duplicateIds = new Set(duplicates.map(idOf));
    for (const name of [SPAN_NAMES.evaluate, SPAN_NAMES.fanout]) {
      const orphans = named(run.spans, name).filter((s) => duplicateIds.has(parentOf(s) as string));
      expect(orphans).toEqual([]);
    }
    for (const duplicate of duplicates) {
      const children = run.spans.filter((s) => parentOf(s) === idOf(duplicate));
      expect(children.map((s) => s.name).sort()).toEqual([SPAN_NAMES.validate, SPAN_NAMES.store]);
    }
  });
});

describe("a rejected frame", () => {
  it("ends its validation span red and opens nothing downstream", async () => {
    // Its own server: malformed frames must not perturb a fixture replay.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const traced = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {
      tracer: provider.getTracer("test"),
      now: fixedClock(),
    });
    await traced.listen({ host: "127.0.0.1", port: 0 });
    const port = (traced.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const badJson = await sendAndAwaitReply(ws, "{not json");
    const badFrame = await sendAndAwaitReply(ws, JSON.stringify({ v: 1, deviceId: "x" }));
    expect(badJson.reason).toBe("invalid_json");
    expect(badFrame.reason).toBe("invalid_frame");

    const spans = exporter.getFinishedSpans();
    expect(named(spans, SPAN_NAMES.ingest)).toHaveLength(2);
    expect(named(spans, SPAN_NAMES.validate)).toHaveLength(2);
    // Nothing downstream ran, so nothing downstream is traced.
    expect(named(spans, SPAN_NAMES.store)).toEqual([]);
    expect(named(spans, SPAN_NAMES.evaluate)).toEqual([]);
    expect(named(spans, SPAN_NAMES.fanout)).toEqual([]);

    const outcomes = named(spans, SPAN_NAMES.ingest).map(
      (s) => s.attributes[SPAN_ATTRIBUTES.ingestOutcome],
    );
    expect(outcomes).toEqual(["invalid_json", "invalid_frame"]);
    // SpanStatusCode.ERROR === 2; a red span is what a query filters on.
    expect(named(spans, SPAN_NAMES.validate).map((s) => s.status.code)).toEqual([2, 2]);
    // A rejected frame never names a device: the id came off a payload the
    // server refused to trust.
    for (const span of named(spans, SPAN_NAMES.ingest)) {
      expect(span.attributes[SPAN_ATTRIBUTES.deviceId]).toBeUndefined();
    }

    ws.close();
    await traced.close();
    await provider.shutdown();
  }, 30_000);
});

describe("a frame that crashes the handler", () => {
  it("ends the ingest span red, with the open child closed and the error recorded", async () => {
    // The inverted-signal case: without this the `finally` would end the ingest
    // span carrying no status and no outcome, so the one span an incident
    // starts from would look healthy while a child was silently missing.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const app = fastify({ logger: false });
    await app.register(fastifyWebsocket, {
      options: { maxPayload: INGEST_MAX_PAYLOAD_BYTES },
    });
    // An engine that throws while evaluating, which is a real path:
    // alerts.ts throws when a rule is active without an active alert.
    const engine = new AlertEngine();
    engine.process = () => {
      throw new Error("engine exploded");
    };
    await app.register(ingestPlugin, {
      store: new VitalsStore(16),
      engine,
      counters: { received: 0, rejectedInvalid: 0 },
      tracer: provider.getTracer("test"),
      now: fixedClock(),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // The throw is deliberately left propagating. A `ws` message handler that
    // raises produces an uncaught exception and would end the process, and
    // that was true before this commit too — instrumentation must not quietly
    // convert a crash into a handled error, so the span is marked and the
    // error is rethrown unchanged. That makes the exception this test's
    // problem to contain, not the code's to swallow: vitest's own
    // uncaughtException listeners are stood down for the one send and restored
    // straight after.
    const savedListeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const caught: unknown[] = [];
    process.on("uncaughtException", (err) => caught.push(err));
    try {
      ws.send(JSON.stringify(goldenFrames()[0]));
      // No reply is coming — the handler threw before the ack. Wait for the span.
      const deadline = Date.now() + 5_000;
      while (named(exporter.getFinishedSpans(), SPAN_NAMES.ingest).length === 0) {
        if (Date.now() > deadline) throw new Error("no ingest span was ever exported");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const listener of savedListeners) {
        process.on("uncaughtException", listener as (err: Error) => void);
      }
    }
    expect((caught[0] as Error).message).toBe("engine exploded");

    const spans = exporter.getFinishedSpans();
    const ingestSpan = named(spans, SPAN_NAMES.ingest)[0] as ReadableSpan;
    // SpanStatusCode.ERROR === 2.
    expect(ingestSpan.status.code).toBe(2);
    expect(ingestSpan.attributes[SPAN_ATTRIBUTES.ingestOutcome]).toBe("error");
    expect(ingestSpan.events.map((e) => e.name)).toContain("exception");

    // The child that was open when the throw happened was closed, not dropped,
    // so the trace shows how far the frame got.
    const evaluate = named(spans, SPAN_NAMES.evaluate);
    expect(evaluate).toHaveLength(1);
    expect(parentOf(evaluate[0] as ReadableSpan)).toBe(idOf(ingestSpan));
    // Fan-out never ran, and the trace says so by its absence.
    expect(named(spans, SPAN_NAMES.fanout)).toEqual([]);

    ws.close();
    await app.close();
    await provider.shutdown();
  }, 30_000);
});

describe("fan-out with no broadcaster registered", () => {
  it("reports zero messages published rather than pretending it fanned out", async () => {
    // ingestPlugin documents `broadcaster` as optional — "omitted, ingest runs
    // unchanged" — and until this test nothing had ever registered it without
    // one, so the claim and the fan-out span's arithmetic were both unproven.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const app = fastify({ logger: false });
    await app.register(fastifyWebsocket, {
      options: { maxPayload: INGEST_MAX_PAYLOAD_BYTES },
    });
    await app.register(ingestPlugin, {
      store: new VitalsStore(16),
      engine: new AlertEngine(),
      counters: { received: 0, rejectedInvalid: 0 },
      tracer: provider.getTracer("test"),
      now: fixedClock(),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const reply = await sendAndAwaitReply(ws, JSON.stringify(goldenFrames()[0]));
    expect(reply.type).toBe("ack");

    const fanout = named(exporter.getFinishedSpans(), SPAN_NAMES.fanout);
    expect(fanout).toHaveLength(1);
    expect(fanout[0]?.attributes[SPAN_ATTRIBUTES.messageCount]).toBe(0);
    expect(fanout[0]?.attributes[SPAN_ATTRIBUTES.subscriberCount]).toBe(0);

    ws.close();
    await app.close();
    await provider.shutdown();
  }, 30_000);
});

describe("instrumentation does not move an alert", () => {
  it("produces byte-identical alert output traced and untraced", async () => {
    const frames = goldenFrames();
    const traced = await replay(frames, true);
    const untraced = await replay(frames, false);

    try {
      // The same fixture, the same injected receive clock, one run traced and
      // one not. The comparison is the raw response body — alertId (which
      // embeds the raise timestamp and the per-device ordinal), both lifecycle
      // stamps, and every window statistic — so a difference of one sample in
      // a window, or one millisecond in a raise, fails here.
      expect(traced.alertsBody).toBe(untraced.alertsBody);
      expect(JSON.parse(traced.alertsBody).alerts).toHaveLength(1);

      // And the spans really were recorded, so this is not two silent runs
      // agreeing with each other.
      expect(traced.spans.length).toBeGreaterThan(0);
      expect(untraced.spans).toEqual([]);
    } finally {
      await traced.close();
      await untraced.close();
    }
  }, 60_000);
});
