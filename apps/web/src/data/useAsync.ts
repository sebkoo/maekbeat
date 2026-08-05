import { useCallback, useEffect, useState } from "react";

/*
 * One read, three honest outcomes. Every route renders from this union, which
 * is why "loading", "empty", and "error" cannot become afterthoughts: there is
 * no state in which a component can render nothing and call it a screen.
 */
export type AsyncState<T> =
  { status: "loading" } | { status: "error"; error: Error } | { status: "ready"; data: T };

export interface AsyncResult<T> {
  state: AsyncState<T>;
  /** Re-runs the read; the retry affordance on the error state. */
  reload: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Runs one read and reports it as state. `deps` must keep a constant length
 * across renders — React compares dependency arrays positionally, and this
 * hook appends its own retry counter to the caller's list.
 */
export function useAsync<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    // Started synchronously, so the read is in flight before this effect
    // returns; a `run` that throws before its first await becomes an error
    // state rather than an exception escaping the effect.
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (cause) {
      pending = Promise.reject(cause);
    }
    pending.then(
      (data) => {
        // A superseded read — the screen was left, the device id changed, or
        // a retry overtook it — must never repaint the current one.
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: toError(cause) });
      },
    );
    return () => controller.abort();
    // `run` is a fresh closure on every render; the caller's deps are the
    // contract for when a read actually repeats.
  }, [...deps, attempt]);

  return { state, reload };
}
