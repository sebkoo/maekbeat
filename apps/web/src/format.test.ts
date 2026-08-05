import { describe, expect, it } from "vitest";

import { formatDelta, formatInstant, formatNumber } from "./format";

describe("formatInstant", () => {
  it("renders epoch milliseconds in UTC, independent of the viewer's timezone", () => {
    expect(formatInstant(1_754_000_012_000)).toBe("2025-07-31 22:13:32Z");
  });

  // z.int().positive() admits stamps far outside the Date range — a gateway
  // sending microseconds passes the wire contract. Rendering a dash beats
  // throwing the screen away.
  it("renders a dash for a stamp Date cannot represent", () => {
    expect(formatInstant(9e15)).toBe("—");
    expect(formatInstant(Number.NaN)).toBe("—");
  });
});

describe("formatNumber", () => {
  it("keeps a fixed number of decimals so columns do not reflow", () => {
    expect(formatNumber(72)).toBe("72");
    expect(formatNumber(97.549, 1)).toBe("97.5");
    expect(formatNumber(0.1, 2)).toBe("0.10");
  });

  it("renders a dash for a value that is not a number — never the string NaN", () => {
    expect(formatNumber(Number.NaN, 1)).toBe("—");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDelta", () => {
  it("signs the drift in both directions", () => {
    expect(formatDelta(310)).toBe("+310 ms");
    expect(formatDelta(0)).toBe("+0 ms");
    // A device clock ahead of the server produces a negative delta; it is a
    // drift signal to read, not an error to hide (docs/ARCHITECTURE.md).
    expect(formatDelta(-1_200.4)).toBe("−1200 ms");
  });
});
