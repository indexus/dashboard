import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Vendored himo.place WebGPU heatmap (src/himo). It also carries the SDK both
 * read modes go through: Aggregate via Grid/Cube, Nearby via Local.
 */
const himoSrc = path.join(__dirname, "src/himo");
const nm = path.join(__dirname, "node_modules");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "buffer", replacement: path.join(nm, "buffer") },
      { find: "earcut", replacement: path.join(nm, "earcut") },
      { find: "d3", replacement: path.join(nm, "d3") },
      { find: "axios", replacement: path.join(nm, "axios") },
      { find: "maplibre-gl", replacement: path.join(nm, "maplibre-gl") },
      { find: /^@himo\/(.*)$/, replacement: path.join(himoSrc, "$1") },
    ],
    dedupe: ["maplibre-gl", "react", "react-dom", "buffer", "d3", "axios", "earcut"],
  },
  define: {
    global: "globalThis",
    "process.env.REACT_APP_INDEXUS_PEERS": "undefined",
  },
  optimizeDeps: {
    include: ["buffer", "axios", "maplibre-gl", "d3", "earcut"],
  },
  worker: {
    format: "es",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3847",
        changeOrigin: true,
        timeout: 10_000,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.warn("[vite] /api proxy:", err.code || err.message);
            if (res && !res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "dashboard api unavailable (is server.js on :3847?)",
                  detail: err.code || err.message,
                })
              );
            }
          });
        },
      },
    },
    fs: {
      allow: [__dirname],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  root: __dirname,
});
