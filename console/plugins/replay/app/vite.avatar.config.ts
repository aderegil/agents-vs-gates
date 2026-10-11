import { defineConfig } from "vite";

// Second build: the shared avatar module for the Teams & Avatars plugin (plain ES module, no React).
export default defineConfig({
  build: {
    outDir: "../../teams/web",
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    lib: {
      entry: "src/avatar-lib.ts",
      formats: ["es"],
      fileName: () => "avatar.js",
    },
  },
});
