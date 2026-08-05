import type { AlertEvent } from "@maekbeat/protocol";

import {
  alertsPageSchema,
  deviceListSchema,
  framesPageSchema,
  healthSchema,
  type AlertsPage,
  type DeviceList,
  type FramesPage,
  type Health,
  type StoredFrame,
} from "./contracts";
import { createHttpClient, type FetchLike } from "./http";
import {
  openStream,
  type ConnectionState,
  type Scheduler,
  type SocketFactory,
  type StreamSubscription,
} from "./stream";

/*
 * Typed client for the apps/server route surface (apps/server/src/openapi.test.ts
 * pins the list): /healthz, /devices, /devices/:deviceId/frames,
 * /devices/:deviceId/alerts over HTTP, and /ingest over WebSocket — the fifth
 * route, whose URL is derived here while the socket itself belongs to C11.
 *
 * Two members have no screen behind them yet and are kept deliberately, not by
 * accident: `health()` is the liveness read a connection banner will use, and
 * `ingestUrl()` is where C11's socket gets its address. Both are exercised by
 * src/api/client.test.ts so neither can rot untested.
 */

export const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

export interface FramesQuery {
  /** Inclusive lower bound on capturedAtMs. */
  since?: number;
  /** Server default 100, maximum 1000. */
  limit?: number;
}

/** What a subscriber gets from the fan-out socket, already contract-checked. */
export interface DeviceStreamHandlers {
  onFrame: (frame: StoredFrame) => void;
  onAlert: (alert: AlertEvent) => void;
  onState: (state: ConnectionState) => void;
  /** A re-open: the caller back-fills the missed window over REST. */
  onReconnect: () => void;
  onInvalidMessage?: () => void;
}

export interface MaekbeatApi {
  readonly baseUrl: string;
  health(signal?: AbortSignal): Promise<Health>;
  listDevices(signal?: AbortSignal): Promise<DeviceList>;
  readFrames(deviceId: string, query?: FramesQuery, signal?: AbortSignal): Promise<FramesPage>;
  readAlerts(deviceId: string, signal?: AbortSignal): Promise<AlertsPage>;
  /** The streaming member the C10 seam was built for (C11). */
  subscribe(deviceId: string, handlers: DeviceStreamHandlers): StreamSubscription;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Socket and timer seams, injected in tests exactly like fetchImpl. */
  createSocket?: SocketFactory;
  schedule?: Scheduler;
}

/** VITE_API_BASE_URL (.env.example) with a development fallback. */
export function resolveApiBaseUrl(configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_API_BASE_URL;
}

function wsBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
}

/** WebSocket URL of the ingest route — device to server, driven by the gateway. */
export function ingestUrl(baseUrl: string): string {
  return `${wsBase(baseUrl)}/ingest`;
}

/** WebSocket URL of the dashboard fan-out for one device — server to dashboard. */
export function streamUrl(baseUrl: string, deviceId: string): string {
  return `${wsBase(baseUrl)}/devices/${encodeURIComponent(deviceId)}/stream`;
}

function queryString(query: FramesQuery): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function createApiClient(options: ApiClientOptions = {}): MaekbeatApi {
  const http = createHttpClient({
    baseUrl: resolveApiBaseUrl(options.baseUrl),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    baseUrl: http.baseUrl,
    health: (signal) => http.getJson("/healthz", healthSchema, signal),
    listDevices: (signal) => http.getJson("/devices", deviceListSchema, signal),
    readFrames: (deviceId, query = {}, signal) =>
      http.getJson(
        `/devices/${encodeURIComponent(deviceId)}/frames${queryString(query)}`,
        framesPageSchema,
        signal,
      ),
    readAlerts: (deviceId, signal) =>
      http.getJson(`/devices/${encodeURIComponent(deviceId)}/alerts`, alertsPageSchema, signal),
    subscribe: (deviceId, handlers) =>
      openStream(
        streamUrl(http.baseUrl, deviceId),
        {
          onMessage: (message) => {
            // `ready` carries the server's ring capacity; the client's own
            // window is what it can back-fill, so nothing to do with it here.
            if (message.type === "frame") handlers.onFrame(message.frame);
            else if (message.type === "alert") handlers.onAlert(message.alert);
          },
          onState: handlers.onState,
          onReconnect: handlers.onReconnect,
          ...(handlers.onInvalidMessage ? { onInvalidMessage: handlers.onInvalidMessage } : {}),
        },
        {
          ...(options.createSocket ? { createSocket: options.createSocket } : {}),
          ...(options.schedule ? { schedule: options.schedule } : {}),
        },
      ),
  };
}
