import { alertEventSchema, vitalsFrameSchema } from "@maekbeat/protocol";
import { z } from "zod";

/*
 * Response contracts for the apps/server read surface. The dashboard is the
 * third consumer of @maekbeat/protocol — after packages/vitals-sim (C2) and
 * apps/server (C6), and before the iOS app mirrors it in Swift at C14 — so
 * frames and alert events are validated with the shared schemas themselves
 * rather than re-described here.
 *
 * Strictness splits deliberately:
 *   - contract objects (frame, alert event) stay strict — that is the wire
 *     rule, where an unknown key means a corrupted or forged payload and a
 *     real change bumps the protocol version;
 *   - transport envelopes (the listing and page wrappers) are permissive, so
 *     a server that adds a counter does not blank a caregiver's screen.
 */

/** A frame as apps/server serves it: the wire frame plus the two server-side stamps. */
export const storedFrameSchema = vitalsFrameSchema.extend({
  receivedAtMs: z.int(),
  sessionEpoch: z.int().positive(),
});
export type StoredFrame = z.infer<typeof storedFrameSchema>;

export const healthSchema = z.object({
  status: z.literal("ok"),
  uptimeSec: z.number(),
  version: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export const deviceSummarySchema = z.object({
  deviceId: z.string(),
  sessionEpoch: z.int(),
  frameCount: z.int(),
  lastSeq: z.int(),
  lastReceivedAtMs: z.int(),
  duplicatesDropped: z.int(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceListSchema = z.object({
  ingest: z.object({
    received: z.int(),
    accepted: z.int(),
    rejectedInvalid: z.int(),
    duplicatesDropped: z.int(),
    sessionsStarted: z.int(),
  }),
  devices: z.array(deviceSummarySchema),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

export const framesPageSchema = z.object({
  deviceId: z.string(),
  count: z.int(),
  frames: z.array(storedFrameSchema),
});
export type FramesPage = z.infer<typeof framesPageSchema>;

export const alertsPageSchema = z.object({
  deviceId: z.string(),
  counters: z.object({
    raised: z.int(),
    resolved: z.int(),
    suppressed: z.int(),
  }),
  alerts: z.array(alertEventSchema),
});
export type AlertsPage = z.infer<typeof alertsPageSchema>;
