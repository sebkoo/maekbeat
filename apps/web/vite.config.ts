import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is a static bundle; it talks to apps/server over the network,
// so there is no proxy here — VITE_API_BASE_URL names the server (.env.example).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: true },
});
