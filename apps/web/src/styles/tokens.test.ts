import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The design tokens are a contract, not decoration. This suite reads the CSS
 * as text and fails the build when:
 *   - a token family is missing, or a second accent appears;
 *   - the dark theme forgets a colour token (or redefines a non-colour one);
 *   - a text pair drops under WCAG 2.2 SC 1.4.3 contrast minimum in either theme;
 *   - a stylesheet outside tokens.css names a colour literal;
 *   - a var(--mb-*) reference has no definition, or a definition has no reader.
 *
 * The last check is the anti-decoration gate: a token nothing reads is deleted,
 * not kept "for later".
 */

// Read from disk rather than imported: Vitest stubs CSS imports (including
// ?raw) to keep component tests free of styling side effects, so the only way
// to assert on the stylesheet the browser gets is to read the file itself.
// process.cwd() is the package root under both `pnpm test` and `pnpm -r
// test:coverage`; source() throws by name if that ever stops holding.
const SRC_DIR = join(process.cwd(), "src");

const SOURCES = new Map<string, string>(
  readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => /\.(?:ts|tsx|css)$/.test(entry))
    .map((entry) => [entry, readFileSync(join(SRC_DIR, entry), "utf8")]),
);

function source(path: string): string {
  const found = SOURCES.get(path);
  if (found === undefined) throw new Error(`no such source file: ${path}`);
  return found;
}

const TOKENS_PATH = "styles/tokens.css";
const TOKENS_CSS = source(TOKENS_PATH);
const APP_CSS = source("styles/app.css");

const DARK_MARKER = "@media (prefers-color-scheme: dark)";
const darkStart = TOKENS_CSS.indexOf(DARK_MARKER);

function declarationsIn(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--mb-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) declarations.set(name, value.trim());
  }
  return declarations;
}

const LIGHT = declarationsIn(TOKENS_CSS.slice(0, darkStart));
const DARK = declarationsIn(TOKENS_CSS.slice(darkStart));

// Any colour notation, not just hex: a token written as oklch() or rgb() must
// stay inside the dark-theme parity gate rather than slipping out of it.
const COLOUR_VALUE = /^#|^(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/i;
const isColour = (value: string) => COLOUR_VALUE.test(value);

function valueIn(theme: "light" | "dark", token: string): string {
  const value = theme === "dark" ? (DARK.get(token) ?? LIGHT.get(token)) : LIGHT.get(token);
  if (value === undefined) throw new Error(`undefined token: ${token}`);
  return value;
}

/** WCAG 2.1 relative luminance of a #rrggbb value. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const ALERT_STATES = ["raised", "ongoing", "resolved"] as const;

describe("token contract", () => {
  it("defines every family the interface draws from", () => {
    for (const token of [
      "--mb-color-canvas",
      "--mb-color-surface",
      "--mb-color-surface-sunken",
      "--mb-color-border",
      "--mb-color-border-strong",
      "--mb-color-text",
      "--mb-color-text-muted",
      "--mb-space-1",
      "--mb-space-6",
      "--mb-font-sans",
      "--mb-font-mono",
      "--mb-text-xs",
      "--mb-text-xl",
      "--mb-leading-tight",
      "--mb-leading-normal",
      "--mb-radius-sm",
      "--mb-radius-pill",
    ]) {
      expect(LIGHT.has(token), `${token} is not defined`).toBe(true);
    }
    expect([...LIGHT.keys()].filter((token) => token.startsWith("--mb-space-"))).toHaveLength(6);
  });

  it("carries exactly one accent — this is a clinical-adjacent surface, not a landing page", () => {
    const accents = [...LIGHT.keys()].filter((token) => token.includes("accent"));
    expect(accents.sort()).toEqual(["--mb-color-accent", "--mb-color-accent-contrast"]);
  });

  it("gives every alert state a mark and a border style, not only a colour", () => {
    for (const state of ALERT_STATES) {
      for (const facet of ["fg", "bg", "border", "mark", "border-style"]) {
        expect(LIGHT.has(`--mb-alert-${state}-${facet}`), `${state} is missing ${facet}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps the three states distinguishable with hue removed entirely", () => {
    const marks = ALERT_STATES.map((state) => LIGHT.get(`--mb-alert-${state}-mark`));
    const styles = ALERT_STATES.map((state) => LIGHT.get(`--mb-alert-${state}-border-style`));
    expect(new Set(marks).size).toBe(ALERT_STATES.length);
    expect(new Set(styles).size).toBe(ALERT_STATES.length);
  });
});

describe("dark theme", () => {
  it("redefines exactly the colour tokens, and leaves the shape of the UI alone", () => {
    const lightColours = [...LIGHT.entries()]
      .filter(([, value]) => isColour(value))
      .map(([token]) => token);
    expect([...DARK.keys()].sort()).toEqual([...lightColours].sort());
  });

  it("actually changes them — a copied palette is not a dark theme", () => {
    for (const [token, value] of DARK) {
      expect(value, `${token} is identical in both themes`).not.toBe(LIGHT.get(token));
    }
  });
});

describe("contrast", () => {
  // Contrast ratio is a luminance-only metric, so these assertions are also the
  // greyscale check: what keeps the three alert states apart from each other
  // (rather than merely legible) is the mark and border-style pairing above.
  const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["--mb-color-text", "--mb-color-canvas"],
    ["--mb-color-text", "--mb-color-surface"],
    ["--mb-color-text", "--mb-color-surface-sunken"],
    ["--mb-color-text-muted", "--mb-color-canvas"],
    ["--mb-color-text-muted", "--mb-color-surface"],
    ["--mb-color-text-muted", "--mb-color-surface-sunken"],
    ["--mb-color-accent", "--mb-color-canvas"],
    ["--mb-color-accent", "--mb-color-surface"],
    // The disclaimer link sits on the sunken strip; it is the one control that
    // must stay legible on every screen of this app.
    ["--mb-color-accent", "--mb-color-surface-sunken"],
    ["--mb-color-accent-contrast", "--mb-color-accent"],
    // The failure-state marks are drawn on the panel surface, not on their own
    // alert background (app.css, .mb-state--error / --disconnected).
    ["--mb-alert-raised-fg", "--mb-color-surface"],
    ["--mb-alert-ongoing-fg", "--mb-color-surface"],
    // The C12 timeline draws the decision mark on the card surface.
    ["--mb-alert-resolved-fg", "--mb-color-surface"],
    ...ALERT_STATES.map((state) => [`--mb-alert-${state}-fg`, `--mb-alert-${state}-bg`] as const),
  ];

  // Non-text pairs that still carry meaning: the alert borders encode state and
  // border-strong outlines the one dashed placeholder. Hairline dividers
  // (--mb-color-border) are decorative separation and are deliberately not gated.
  const UI_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["--mb-color-border-strong", "--mb-color-surface"],
    // The timeline row's leading edge sits on the card surface (C12).
    ...ALERT_STATES.map((state) => [`--mb-alert-${state}-border`, "--mb-color-surface"] as const),
    ...ALERT_STATES.map(
      (state) => [`--mb-alert-${state}-border`, `--mb-alert-${state}-bg`] as const,
    ),
  ];

  for (const theme of ["light", "dark"] as const) {
    it(`holds 4.5:1 on every text pair in the ${theme} theme`, () => {
      for (const [foreground, background] of TEXT_PAIRS) {
        const ratio = contrastRatio(valueIn(theme, foreground), valueIn(theme, background));
        expect(
          ratio,
          `${foreground} on ${background} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`holds 3:1 on every meaningful non-text pair in the ${theme} theme`, () => {
      for (const [foreground, background] of UI_PAIRS) {
        const ratio = contrastRatio(valueIn(theme, foreground), valueIn(theme, background));
        expect(
          ratio,
          `${foreground} on ${background} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe("tokens are the only source of values", () => {
  // Every shipped file, not just app.css: C11 adds a chart, and an SVG fill is
  // the obvious way a colour would re-enter the codebase behind the gate.
  const shipped = [...SOURCES].filter(([path]) => path !== TOKENS_PATH && !path.includes(".test."));

  it("names no colour literal outside tokens.css", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/gi;
    for (const [path, code] of shipped) {
      expect(code.match(literal), `${path} names a colour literal`).toBeNull();
    }
  });

  it("keeps colour out of component markup — no inline style or paint attribute", () => {
    const paintAttribute = /\b(?:fill|stroke|stop-color|bgcolor)\s*=/i;
    for (const [path, code] of shipped) {
      if (path.endsWith(".css")) continue;
      expect(code, `${path} sets inline styles`).not.toContain("style={{");
      expect(paintAttribute.test(code), `${path} paints with an attribute`).toBe(false);
    }
  });

  // WCAG 2.2 SC 2.5.8 is a layout property, and jsdom has no layout — so the
  // guarantee is asserted where it is actually made: in the declaration.
  it("declares a target size for every control, past the 24px minimum", () => {
    const button = APP_CSS.slice(APP_CSS.indexOf(".mb-button {"));
    const block = button.slice(0, button.indexOf("}"));
    const minWidth = /min-width:\s*([\d.]+)rem/.exec(block);
    const minHeight = /min-height:\s*([\d.]+)rem/.exec(block);
    expect(minWidth, ".mb-button declares no min-width").not.toBeNull();
    expect(minHeight, ".mb-button declares no min-height").not.toBeNull();
    // rem is 16px by default and this stylesheet never changes the root size.
    // 44 px is what the stylesheet declares and what the README claims; the
    // SC 2.5.8 floor is 24, and pinning the larger number keeps the two honest.
    expect(Number(minWidth?.[1]) * 16).toBeGreaterThanOrEqual(44);
    expect(Number(minHeight?.[1]) * 16).toBeGreaterThanOrEqual(44);
  });

  it("keeps the network inside the two transport modules", () => {
    // Transport isolation, asserted rather than trusted: no component or hook
    // may open its own connection. src/api/http.ts holds the fetch layer and
    // src/api/stream.ts the fan-out socket (C11); nothing else may.
    const TRANSPORT_MODULES = new Set(["api/http.ts", "api/stream.ts"]);
    const transport = /\bfetch\(|new WebSocket\(|XMLHttpRequest|navigator\.sendBeacon|EventSource/;
    for (const [path, code] of shipped) {
      if (TRANSPORT_MODULES.has(path)) continue;
      expect(transport.test(code), `${path} reaches the network directly`).toBe(false);
    }
  });

  it("resolves every var(--mb-*) reference to a defined token", () => {
    for (const [path, code] of SOURCES) {
      for (const [, token] of code.matchAll(/var\((--mb-[a-z0-9-]+)\)/g)) {
        expect(LIGHT.has(token as string), `${path} reads undefined ${token}`).toBe(true);
      }
    }
  });

  it("has a reader for every token it defines", () => {
    const readers = [...SOURCES]
      .filter(([path]) => path !== TOKENS_PATH && !path.includes(".test."))
      .map(([, code]) => code)
      .join("\n");
    for (const token of LIGHT.keys()) {
      expect(readers.includes(`var(${token})`), `${token} is defined but never read`).toBe(true);
    }
  });
});
