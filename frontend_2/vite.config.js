import { defineConfig } from "vite";

// Phase 0: dev server on :5173, /api proxied to backend_2 on :8080.
// The app only ever calls relative /api/* routes (repo AGENTS.md rule),
// so no CORS configuration is needed in development.
export default defineConfig({
  root: ".",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
