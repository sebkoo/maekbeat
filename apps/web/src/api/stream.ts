import { streamMessageSchema, type StreamMessage } from "@maekbeat/protocol";

/*
 * The fan-out transport: the second (and last) place in apps/web that touches
 * the network, alongside http.ts — the source scan in src/styles/tokens.test.ts
 * enforces that. The socket is behind a port so tests drive a fake one; nothing
 * here needs a real server, a real timer, or a real clock.
 */

/**
 * What the connection is doing, in the user's terms rather than the socket's.
 * `disconnected` is reached after DISCONNECTED_AFTER_ATTEMPTS consecutive
 * failures — retries continue at the capped interval, but the dashboard stops
 * implying that data is about to arrive.
 */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "disconnected";

/** First retry delay; each attempt doubles it up to the cap. */
export const BACKOFF_BASE_MS = 500;
/** The cap: a dashboard left open overnight retries every 15 s, not every hour. */
export const MAX_BACKOFF_MS = 15_000;

/** Consecutive failed attempts before the UI says disconnected rather than reconnecting. */
export const DISCONNECTED_AFTER_ATTEMPTS = 3;

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
}

export interface SocketPort {
  close: () => void;
}

/** Injectable socket constructor; the default wraps the platform WebSocket. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketPort;

/** Injectable timer; returns its own canceller. */
export type Scheduler = (run: () => void, delayMs: number) => () => void;

export interface StreamHandlers {
  /** Every message that satisfies the @maekbeat/protocol contract. */
  onMessage: (message: StreamMessage) => void;
  onState: (state: ConnectionState) => void;
  /** Fired after a re-open, never after the first open: the caller back-fills. */
  onReconnect: () => void;
  /** A message the contract rejects; dropped, counted, never rendered. */
  onInvalidMessage?: (raw: string) => void;
}

export interface StreamOptions {
  createSocket?: SocketFactory;
  schedule?: Scheduler;
}

export interface StreamSubscription {
  close: () => void;
}

const defaultSocketFactory: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  });
  // A socket that errors also closes; one path into the retry loop is enough.
  socket.addEventListener("close", () => handlers.onClose());
  return {
    close: () => socket.close(),
  };
};

const defaultScheduler: Scheduler = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
};

/** Capped exponential backoff: 500 ms, 1 s, 2 s, 4 s, 8 s, then 15 s forever. */
export function backoffFor(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), MAX_BACKOFF_MS);
}

/**
 * Opens the fan-out socket and keeps it open: on close it retries with capped
 * exponential backoff, and every successful re-open tells the caller to
 * back-fill rather than resuming as if nothing had been missed. Silence is
 * never treated as continuity — that is the whole point of the reconnect path.
 */
export function openStream(
  url: string,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): StreamSubscription {
  const createSocket = options.createSocket ?? defaultSocketFactory;
  const schedule = options.schedule ?? defaultScheduler;

  let socket: SocketPort | undefined;
  let cancelRetry: (() => void) | undefined;
  let failures = 0;
  let hasConnected = false;
  let closedByCaller = false;

  let reported: ConnectionState | undefined;

  /** Transitions only: a retry loop repeating "disconnected" is not news. */
  const setState = (state: ConnectionState) => {
    if (closedByCaller || state === reported) return;
    reported = state;
    handlers.onState(state);
  };

  /**
   * One rule for the label, used before and after every attempt. Deriving it
   * in two places let a server that was never up flip between "connecting" and
   * "disconnected" forever, and call a connection that never existed a
   * reconnection.
   */
  const currentState = (): ConnectionState => {
    if (failures >= DISCONNECTED_AFTER_ATTEMPTS) return "disconnected";
    return hasConnected ? "reconnecting" : "connecting";
  };

  const retryAfterFailure = () => {
    failures += 1;
    setState(currentState());
    cancelRetry = schedule(connect, backoffFor(failures - 1));
  };

  const connect = () => {
    if (closedByCaller) return;
    setState(currentState());

    let opened: SocketPort;
    try {
      opened = createSocket(url, {
        onOpen: () => {
          if (closedByCaller) return;
          failures = 0;
          const reopened = hasConnected;
          hasConnected = true;
          setState("live");
          if (reopened) handlers.onReconnect();
        },
        // Delivery stops at close(), not just state reporting: a socket the
        // caller has let go must not push into a screen that moved on.
        onMessage: (data) => {
          if (closedByCaller) return;
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            handlers.onInvalidMessage?.(data);
            return;
          }
          const parsed = streamMessageSchema.safeParse(payload);
          if (!parsed.success) {
            handlers.onInvalidMessage?.(data);
            return;
          }
          handlers.onMessage(parsed.data);
        },
        onClose: () => {
          if (closedByCaller) return;
          socket = undefined;
          retryAfterFailure();
        },
      });
    } catch {
      // A constructor that throws — an unusable URL, for instance — must not
      // end the retry loop and freeze the badge on a dashboard that has
      // silently stopped trying.
      socket = undefined;
      retryAfterFailure();
      return;
    }
    if (closedByCaller) opened.close();
    else socket = opened;
  };

  connect();

  return {
    close: () => {
      closedByCaller = true;
      cancelRetry?.();
      cancelRetry = undefined;
      socket?.close();
      socket = undefined;
    },
  };
}
