import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
// VITE_MOCK=1 swaps the real Tauri backend for the in-memory fixture backend
// (test harness only, SPEC §0). Release builds never set it.
const mock = process.env.VITE_MOCK === "1";
if (mock && process.env.TAURI_ENV_PLATFORM) {
  throw new Error("VITE_MOCK=1 must never be used for a Tauri build (the mock backend is a test harness).");
}

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@api-impl": fileURLToPath(
        new URL(mock ? "./src/api/mock.ts" : "./src/api/tauri.ts", import.meta.url),
      ),
    },
  },
  build: {
    outDir: mock ? "dist-mock" : "dist",
    target: "es2022",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
