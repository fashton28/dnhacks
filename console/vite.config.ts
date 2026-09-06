import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * MapLibre 6 runs its GeoJSON and symbol work in a Web Worker. The worker is a hashed `?url` asset, but it
 * imports `./maplibre-gl-shared.mjs` by its plain name, so the bundle must carry that exact file next to it.
 * Without it the Overview's vector layers never render (the style never finishes loading) while imagery still shows.
 */
function maplibreSharedChunk(): Plugin {
  const shared = fileURLToPath(new URL("./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs", import.meta.url));
  return {
    name: "maplibre-shared-chunk",
    apply: "build",
    generateBundle() { this.emitFile({ type: "asset", fileName: "assets/maplibre-gl-shared.mjs", source: readFileSync(shared) }); },
  };
}

export default defineConfig({ base: "./", plugins: [maplibreSharedChunk()], build: { target: "es2022", outDir: "dist" }, server: { port: 5173 } });
