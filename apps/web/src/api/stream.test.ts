import type { StreamMessage } from "@maekbeat/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  backoffFor,
  openStream,
  BACKOFF_BASE_MS,
  MAX_BACKOFF_MS,
  DISCONNECTED_AFTER_ATTEMPTS,
  type ConnectionState,
  type SocketHandlers,
  type SocketPort,
} from "./stream";

const FRAME = {
  v: 1 as const,
  deviceId: "dev-1",
  seq: 4,
  capturedAtMs: 1_754_000_004_000,
  heartRateBpm: 70,
  spo2Pct: 97,
  respirationRpm: 14,
  motion: 0.1,
  receivedAtMs: 1_754_000_004_200,
  sessionEpoch: 1,
};

/** A socket the test drives by hand; nothing here touches a real network. */
class FakeSocket implements SocketPort {
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  open() {
    this.handlers.onOpen();
  }
  deliver(message: unknown) {
    this.handlers.onMessage(typeof message === "string" ? message : JSON.stringify(message));
  }
  drop() {
    this.handlers.onClose();
  }
  close() {
    this.closed = true;
  }
}

/** A scheduler that runs nothing until the test says so. */
function fakeScheduler() {
  const pending: Array<{ run: () => void; delayMs: number }> = [];
  const schedule = (run: () => void, delayMs: number) => {
    const entry = { run, delayMs };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    schedule,
    delays: () => pending.map((entry) => entry.delayMs),
    fire: () => {
      const next = pending.shift();
      next?.run();
    },
    size: () => pending.length,
  };
}

function harness() {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const messages: StreamMessage[] = [];
  const invalid: string[] = [];
  const timers = fakeScheduler();
  const onReconnect = vi.fn();

  const subscription = openStream(
    "ws://api.test/devices/dev-1/stream",
    {
      onMessage: (message) => messages.push(message),
      onState: (state) => states.push(state),
      onReconnect,
      onInvalidMessage: (raw) => invalid.push(raw),
    },
    {
      createSocket: (url, handlers) => {
        const socket = new FakeSocket(url, handlers);
        sockets.push(socket);
        return socket;
      },
      schedule: timers.schedule,
    },
  );

  return { sockets, states, messages, invalid, timers, onReconnect, subscription };
}

describe("openStream", () => {
  it("connects to the device's fan-out route and reports going live", () => {
    const h = harness();
    expect(h.sockets[0]?.url).toBe("ws://api.test/devices/dev-1/stream");
    expect(h.states).toEqual(["connecting"]);

    h.sockets[0]?.open();
    expect(h.states).toEqual(["connecting", "live"]);
    // A first open is not a reconnect: there is nothing to back-fill.
    expect(h.onReconnect).not.toHaveBeenCalled();
  });

  it("delivers only messages the protocol contract accepts", () => {
    const h = harness();
    h.sockets[0]?.open();

    h.sockets[0]?.deliver({
      type: "ready",
      deviceId: "dev-1",
      serverTimeMs: 1,
      ringCapacity: 1024,
    });
    h.sockets[0]?.deliver({ type: "frame", frame: FRAME });
    h.sockets[0]?.deliver({ type: "frame", frame: { ...FRAME, spo2Pct: 140 } });
    h.sockets[0]?.deliver({ type: "gossip" });
    h.sockets[0]?.deliver("{not json");

    expect(h.messages.map((message) => message.type)).toEqual(["ready", "frame"]);
    expect(h.invalid).toHaveLength(3);
  });

  it("retries with capped exponential backoff after a drop", () => {
    const h = harness();
    h.sockets[0]?.open();

    h.sockets[0]?.drop();
    expect(h.states.at(-1)).toBe("reconnecting");
    expect(h.timers.delays()).toEqual([backoffFor(0)]);

    h.timers.fire();
    h.sockets[1]?.drop();
    expect(h.timers.delays()).toEqual([backoffFor(1)]);

    h.timers.fire();
    h.sockets[2]?.drop();
    expect(h.timers.delays()).toEqual([backoffFor(2)]);
  });

  it("doubles the delay per attempt and then caps it", () => {
    expect(backoffFor(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffFor(1)).toBe(1_000);
    expect(backoffFor(2)).toBe(2_000);
    expect(backoffFor(3)).toBe(4_000);
    expect(backoffFor(4)).toBe(8_000);
    // Capped from here on: a dashboard left open retries every 15 s forever.
    expect(backoffFor(5)).toBe(MAX_BACKOFF_MS);
    expect(backoffFor(99)).toBe(MAX_BACKOFF_MS);
    expect(backoffFor(-3)).toBe(BACKOFF_BASE_MS);
  });

  it("says disconnected once retries keep failing, and keeps trying anyway", () => {
    const h = harness();
    h.sockets[0]?.open();

    for (let attempt = 0; attempt < DISCONNECTED_AFTER_ATTEMPTS; attempt++) {
      h.sockets.at(-1)?.drop();
      h.timers.fire();
    }

    expect(h.states.at(-1)).toBe("disconnected");
    expect(h.sockets.length).toBeGreaterThan(DISCONNECTED_AFTER_ATTEMPTS);
  });

  // A server that was never up is not "reconnecting", and the badge must not
  // flip back to "connecting" once it has admitted to being disconnected.
  it("stays honest when the first connection never succeeds", () => {
    const h = harness();

    for (let attempt = 0; attempt < 4; attempt++) {
      h.sockets.at(-1)?.drop();
      h.timers.fire();
    }

    // Transitions only, and never a return to "connecting" once it has said
    // "disconnected": the badge does not flicker while the server is down.
    expect(h.states).toEqual(["connecting", "disconnected"]);
    expect(h.onReconnect).not.toHaveBeenCalled();
  });

  it("keeps retrying when the socket constructor itself throws", () => {
    const states: ConnectionState[] = [];
    const timers = fakeScheduler();
    let attempts = 0;
    const sockets: FakeSocket[] = [];

    openStream(
      "ws://api.test/devices/dev-1/stream",
      { onMessage: () => {}, onState: (state) => states.push(state), onReconnect: () => {} },
      {
        createSocket: (url, handlers) => {
          attempts += 1;
          if (attempts === 1) throw new SyntaxError("bad URL");
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        },
        schedule: timers.schedule,
      },
    );

    // The throw becomes a failed attempt, not an escaped exception.
    expect(timers.size()).toBe(1);
    timers.fire();
    sockets[0]?.open();
    expect(states.at(-1)).toBe("live");
  });

  it("delivers nothing after the caller closes, not even a queued message", () => {
    const h = harness();
    h.sockets[0]?.open();
    const delivered = h.messages.length;

    h.subscription.close();
    // A close() handshake still dispatches messages already queued.
    h.sockets[0]?.deliver({ type: "frame", frame: FRAME });
    h.sockets[0]?.deliver("{not json");

    expect(h.messages).toHaveLength(delivered);
    expect(h.invalid).toHaveLength(0);
  });

  it("asks the caller to back-fill on every re-open, never on the first", () => {
    const h = harness();
    h.sockets[0]?.open();
    expect(h.onReconnect).toHaveBeenCalledTimes(0);

    h.sockets[0]?.drop();
    h.timers.fire();
    h.sockets[1]?.open();

    expect(h.onReconnect).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toBe("live");
  });

  it("closes the socket and cancels a pending retry when the caller closes", () => {
    const h = harness();
    h.sockets[0]?.open();
    h.sockets[0]?.drop();
    expect(h.timers.size()).toBe(1);

    h.subscription.close();

    expect(h.timers.size()).toBe(0);
    const statesAfter = h.states.length;
    h.timers.fire();
    expect(h.sockets).toHaveLength(1);
    expect(h.states).toHaveLength(statesAfter);
  });

  it("closes an open socket on close, and reports nothing afterwards", () => {
    const h = harness();
    h.sockets[0]?.open();

    h.subscription.close();

    expect(h.sockets[0]?.closed).toBe(true);
    const statesAfter = h.states.length;
    // A close event arriving after the caller left must not restart anything.
    h.sockets[0]?.drop();
    expect(h.sockets).toHaveLength(1);
    expect(h.states).toHaveLength(statesAfter);
  });

  // The default seams: what runs in the browser when nothing is injected.
  it("wraps the platform WebSocket when no factory is given", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const instance = { closed: false, url: "" };
    class FakeWebSocket {
      constructor(url: string) {
        instance.url = url;
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
      close() {
        instance.closed = true;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const states: ConnectionState[] = [];
    const messages: StreamMessage[] = [];
    const subscription = openStream(
      "ws://api.test/devices/dev-1/stream",
      {
        onMessage: (message) => messages.push(message),
        onState: (state) => states.push(state),
        onReconnect: () => {},
      },
      { schedule: () => () => {} },
    );

    expect(instance.url).toBe("ws://api.test/devices/dev-1/stream");
    listeners.get("open")?.(undefined);
    expect(states).toEqual(["connecting", "live"]);

    listeners.get("message")?.({ data: JSON.stringify({ type: "frame", frame: FRAME }) });
    // Binary frames are not part of the contract and are ignored, not decoded.
    listeners.get("message")?.({ data: new ArrayBuffer(4) });
    expect(messages).toHaveLength(1);

    listeners.get("close")?.(undefined);
    expect(states.at(-1)).toBe("reconnecting");
    subscription.close();

    // A caller closing a socket that is still open must close the real one.
    const second = openStream(
      "ws://api.test/devices/dev-2/stream",
      { onMessage: () => {}, onState: () => {}, onReconnect: () => {} },
      { schedule: () => () => {} },
    );
    listeners.get("open")?.(undefined);
    second.close();
    expect(instance.closed).toBe(true);
    vi.unstubAllGlobals();
  });

  it("retries on a real timer when no scheduler is given", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    openStream(
      "ws://api.test/devices/dev-1/stream",
      { onMessage: () => {}, onState: () => {}, onReconnect: () => {} },
      {
        createSocket: (url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        },
      },
    );

    sockets[0]?.open();
    sockets[0]?.drop();
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(2);

    // The canceller the default scheduler returns must actually cancel.
    sockets[1]?.drop();
    const subscriptionSockets = sockets.length;
    vi.clearAllTimers();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(subscriptionSockets);
    vi.useRealTimers();
  });

  it("ignores an invalid message with no handler attached", () => {
    const states: ConnectionState[] = [];
    const sockets: FakeSocket[] = [];
    openStream(
      "ws://api.test/devices/dev-1/stream",
      { onMessage: () => {}, onState: (state) => states.push(state), onReconnect: () => {} },
      {
        createSocket: (url, handlers) => {
          const socket = new FakeSocket(url, handlers);
          sockets.push(socket);
          return socket;
        },
        schedule: () => () => {},
      },
    );
    sockets[0]?.open();
    expect(() => sockets[0]?.deliver("{not json")).not.toThrow();
  });
});
