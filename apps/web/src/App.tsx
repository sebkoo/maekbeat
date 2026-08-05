import { Route, Routes } from "react-router";

import { AppShell } from "./components/AppShell";
import { DeviceDetailRoute } from "./routes/DeviceDetailRoute";
import { DeviceListRoute } from "./routes/DeviceListRoute";
import { NotFoundRoute } from "./routes/NotFoundRoute";

/**
 * Routes only. The router itself is provided by the caller — BrowserRouter in
 * src/main.tsx, MemoryRouter in the tests — so navigation is testable without
 * touching history globals.
 */
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DeviceListRoute />} />
        <Route path="/devices/:deviceId" element={<DeviceDetailRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </AppShell>
  );
}
