import { createContext, useContext, type ReactNode } from "react";

import type { MaekbeatApi } from "../api/client";

/*
 * The single seam between components and the network: no component constructs
 * a client or names a URL, and tests inject a fake instead of patching globals.
 * C11 extends MaekbeatApi with a streaming member and adds a subscription hook
 * beside useAsync — the transport arrives through this provider, not inside a
 * component. The chart itself is new markup, so the device page does change.
 */

const ApiContext = createContext<MaekbeatApi | null>(null);

export function ApiProvider(props: { api: MaekbeatApi; children: ReactNode }) {
  return <ApiContext.Provider value={props.api}>{props.children}</ApiContext.Provider>;
}

export function useApi(): MaekbeatApi {
  const api = useContext(ApiContext);
  if (api === null) {
    throw new Error("useApi must be used inside <ApiProvider>");
  }
  return api;
}
