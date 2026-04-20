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
  // Use a relative base for every build (Tauri + web). Web absolute paths
  // ("/assets/...") break sub-path deploys like noobstr.me/planner/: the
  // browser resolves them against the domain root, gets the server's
  // fallback HTML, and the MIME-type guard refuses the asset. "./"
  // resolves against the HTML document's URL, so the same dist works
  // whether the app lives at "/", "/planner/", or an nsite path.
  // Override with VITE_BASE=/something/ if a named absolute path is
  // actually needed for a specific deploy target.
  base: inTauri ? "./" : (process.env.VITE_BASE || "./"),
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
    // Web builds land at the monorepo-root `dist/` so the user can point
    // whatever uploader they use at one obvious path. Tauri keeps its own
    // `apps/planner/dist/` because tauri.conf.json's frontendDist is
    // "../dist" (relative to src-tauri) and changing that cascades into
    // the bundler/icon paths.
    outDir: inTauri ? "dist" : "../../dist",
    emptyOutDir: true,
    target: inTauri ? ["es2021", "chrome105", "safari15"] : "modules",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
