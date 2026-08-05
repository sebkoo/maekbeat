import type { ZodType } from "zod";

/*
 * The fetch layer, and the only place in apps/web that touches the network —
 * asserted by a source scan in src/styles/tokens.test.ts, not left to
 * convention. Components never see it: they read through the data hooks
 * (src/data/), so C11 adds the WebSocket transport beside this module rather
 * than inside a component. `fetchImpl` is the seam the tests use.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiErrorKind =
  /** The request never got an answer: server down, DNS, CORS, offline. */
  | "network"
  /** The server answered with a non-2xx status. */
  | "http"
  /** The server answered, but not with the shape @maekbeat/protocol describes. */
  | "contract";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status;
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: FetchLike;
}

export interface HttpClient {
  readonly baseUrl: string;
  getJson<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** Best-effort message from an error response; the server sends {statusCode, message}. */
function messageFromBody(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "message" in parsed) {
      const { message } = parsed as { message: unknown };
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    // A non-JSON error body is normal (proxies, gateways); fall through.
  }
  return `request failed with status ${status}`;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return {
    baseUrl,
    async getJson<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
      const url = `${baseUrl}${path}`;

      let response: Response;
      try {
        response = await doFetch(url, { signal, headers: { accept: "application/json" } });
      } catch (cause) {
        // An abort is the caller's own doing (route change, unmount) and must
        // stay distinguishable from the server being unreachable.
        if (isAbortError(cause)) throw cause;
        throw new ApiError("network", `cannot reach the Maekbeat API at ${url}`, { cause });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ApiError("http", messageFromBody(body, response.status), {
          status: response.status,
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new ApiError("contract", `${url} did not return JSON`, { cause });
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join(".") || "(root)";
        throw new ApiError(
          "contract",
          `${url} did not match the @maekbeat/protocol contract at ${where}`,
          {
            cause: parsed.error,
          },
        );
      }
      return parsed.data;
    },
  };
}
