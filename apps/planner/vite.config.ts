import path from "node:path";
import fs from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import pkg from "./package.json";

const APP_VERSION = pkg.version;
const inTauri = process.env.TAURI_ENV_TARGET_TRIPLE !== undefined;

/**
 * Post-bundle plugin: substitute `__APP_VERSION__` inside the emitted
 * service worker. `public/` files are copied verbatim and don't pass
 * through the `define` path, so we rewrite them in the final dist.
 * This keeps the sw.js cache name in lockstep with package.json version
 * so stale installs can't keep serving old bundles after a deploy.
 */
function swVersionInjector(): Plugin {
  return {
    name: "sw-version-injector",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? "dist";
      const swPath = path.join(outDir, "sw.js");
      if (!fs.existsSync(swPath)) return;
      const src = fs.readFileSync(swPath, "utf8");
      const replaced = src.replace(/__APP_VERSION__/g, APP_VERSION);
      if (replaced !== src) {
        fs.writeFileSync(swPath, replaced);
      }
    },
  };
}

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
  define: {
    // Inlined into every bundled module at build time — single source of
    // truth for the app version (package.json).
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [react(), swVersionInjector()],
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
