import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static build for the console (kind: iframe). Relative base so the shell can serve it from any plugin path;
// no dev proxy and no server: the theater never calls a model.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../web/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    // build-time profiling hint, not a problem in the code; keeps `npm run build` warning-free
    rolldownOptions: { checks: { bundlerTimings: false } },
  },
  preview: { port: 4174, strictPort: false },
});
