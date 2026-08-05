import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals stay off (tests import what they use), so Testing Library's
// auto-cleanup does not self-register: unmount between tests explicitly.
afterEach(cleanup);
