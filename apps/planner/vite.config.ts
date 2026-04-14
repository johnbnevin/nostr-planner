import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const inTauri = process.env.TAURI_ENV_TARGET_TRIPLE !== undefined;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  // Tauri requires a relative base for desktop/mobile builds
  base: inTauri ? "./" : (process.env.VITE_BASE || "/"),
  server: {
    // Tauri needs a fixed port and host; TAURI_DEV_HOST is set for mobile dev
    host: inTauri ? (process.env.TAURI_DEV_HOST || "localhost") : "::",
    port: 8000,
    strictPort: true,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Optimize Tauri bundle size
  build: {
    target: inTauri ? ["es2021", "chrome105", "safari15"] : "modules",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
