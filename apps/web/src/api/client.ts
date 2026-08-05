import {
  alertsPageSchema,
  deviceListSchema,
  framesPageSchema,
  healthSchema,
  type AlertsPage,
  type DeviceList,
  type FramesPage,
  type Health,
} from "./contracts";
import { createHttpClient, type FetchLike } from "./http";

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

export interface MaekbeatApi {
  readonly baseUrl: string;
  health(signal?: AbortSignal): Promise<Health>;
  listDevices(signal?: AbortSignal): Promise<DeviceList>;
  readFrames(deviceId: string, query?: FramesQuery, signal?: AbortSignal): Promise<FramesPage>;
  readAlerts(deviceId: string, signal?: AbortSignal): Promise<AlertsPage>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** VITE_API_BASE_URL (.env.example) with a development fallback. */
export function resolveApiBaseUrl(configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_API_BASE_URL;
}

/** WebSocket URL of the ingest route; the socket opens at C11 (docs/ROADMAP.md). */
export function ingestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ingest`;
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
  };
}
