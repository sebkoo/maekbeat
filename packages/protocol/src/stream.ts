import { z } from "zod";

import { alertEventSchema } from "./alerts";
import { vitalsFrameSchema } from "./vitals";

/*
 * Server → dashboard fan-out (docs/ARCHITECTURE.md stage 7, shipped C11). The
 * second additive exercise of the evolution policy after alertEventSchema: new
 * schemas only, the vitals frame untouched, protocol version stays 1.
 *
 * Direction matters. /ingest carries device → server frames; this contract
 * carries server → dashboard messages, and it is the first shape on the wire
 * that includes the two server-side stamps.
 */

/**
 * A frame after ingest: the wire frame plus the stamps the server adds.
 * `receivedAtMs` is server clock, `capturedAtMs` is device clock, and their
 * difference is the drift signal of docs/ARCHITECTURE.md.
 */
export const storedVitalsFrameSchema = vitalsFrameSchema.extend({
  receivedAtMs: z.int().positive(),
  sessionEpoch: z.int().positive(),
});
export type StoredVitalsFrame = z.infer<typeof storedVitalsFrameSchema>;

/** Sent once when a dashboard subscribes, before any frame. */
export const streamReadySchema = z.strictObject({
  type: z.literal("ready"),
  deviceId: z.string().min(1).max(64),
  serverTimeMs: z.int().positive(),
  /**
   * Frames the server keeps per device. A dashboard that was away longer than
   * this many frames cannot recover the difference from anywhere — the missing
   * span is a gap, and rendering it as one is the honest option.
   */
  ringCapacity: z.int().positive(),
});

export const streamFrameSchema = z.strictObject({
  type: z.literal("frame"),
  frame: storedVitalsFrameSchema,
});

export const streamAlertSchema = z.strictObject({
  type: z.literal("alert"),
  alert: alertEventSchema,
});

/** Every message a dashboard can receive on the fan-out socket. */
export const streamMessageSchema = z.discriminatedUnion("type", [
  streamReadySchema,
  streamFrameSchema,
  streamAlertSchema,
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;
