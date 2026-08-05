import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useAsync } from "./useAsync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsync", () => {
  it("starts in loading and lands on the data", async () => {
    const { result } = renderHook(() => useAsync(async () => "frames", []));

    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "frames" }));
  });

  it("keeps a failure as a state, not an exception", async () => {
    const boom = new Error("server said no");
    const { result } = renderHook(() => useAsync(() => Promise.reject(boom), []));

    await waitFor(() => expect(result.current.state).toEqual({ status: "error", error: boom }));
  });

  it("wraps a non-Error rejection so the UI always has a message", async () => {
    const { result } = renderHook(() => useAsync(() => Promise.reject("socket closed"), []));

    await waitFor(() => {
      const { state } = result.current;
      expect(state.status).toBe("error");
      if (state.status === "error") expect(state.error.message).toBe("socket closed");
    });
  });

  it("re-runs the read when reload is called", async () => {
    let runs = 0;
    const { result } = renderHook(() => useAsync(async () => ++runs, []));

    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 2 }));
  });

  it("aborts the read on unmount", async () => {
    const late = deferred<string>();
    let signal: AbortSignal | undefined;
    const { unmount } = renderHook(() =>
      useAsync((abortSignal) => {
        signal = abortSignal;
        return late.promise;
      }, []),
    );

    unmount();
    expect(signal?.aborted).toBe(true);
    late.resolve("frames");
    await late.promise;
  });

  // The case the abort guard actually decides: the user moves from device a to
  // device b while a's read is still in flight, and a answers last. Without the
  // guard, b's page paints a's numbers — a wrong patient on a monitoring screen.
  it("drops a superseded read instead of repainting the current one", async () => {
    const slow = deferred<string>();
    const { result, rerender } = renderHook(
      ({ deviceId }: { deviceId: string }) =>
        useAsync(
          (signal) => (deviceId === "a" ? slow.promise : Promise.resolve(`frames-${deviceId}`)),
          [deviceId],
        ),
      { initialProps: { deviceId: "a" } },
    );

    rerender({ deviceId: "b" });
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "ready", data: "frames-b" }),
    );

    await act(async () => {
      slow.resolve("frames-a");
      await slow.promise;
    });
    expect(result.current.state).toEqual({ status: "ready", data: "frames-b" });
  });

  it("drops a superseded failure the same way", async () => {
    const slow = deferred<string>();
    const { result, rerender } = renderHook(
      ({ deviceId }: { deviceId: string }) =>
        useAsync(() => (deviceId === "a" ? slow.promise : Promise.resolve("frames-b")), [deviceId]),
      { initialProps: { deviceId: "a" } },
    );

    rerender({ deviceId: "b" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      slow.reject(new Error("too late"));
      await slow.promise.catch(() => undefined);
    });
    expect(result.current.state).toEqual({ status: "ready", data: "frames-b" });
  });

  it("turns a run that throws before its first await into an error state", async () => {
    const { result } = renderHook(() =>
      useAsync(() => {
        throw new Error("bad transport URL");
      }, []),
    );

    await waitFor(() => {
      const { state } = result.current;
      expect(state.status).toBe("error");
      if (state.status === "error") expect(state.error.message).toBe("bad transport URL");
    });
  });
});
