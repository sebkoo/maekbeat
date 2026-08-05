import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Version reported by /healthz and the OpenAPI document. */
export const packageVersion = manifest.version;
