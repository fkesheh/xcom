import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  // Project Pages site lives at https://fkesheh.github.io/xcom/
  base: process.env.GITHUB_PAGES === "true" ? "/xcom/" : "/",
  server: { port: 5173, open: false },
  build: {
    target: "es2022",
    outDir: "dist",
    // three.js is the bulk of the bundle. The 3D views are dynamically imported
    // from src/game/main.ts (so three loads lazily on first screen mount); this
    // pins every three module (core + addons) into one shared "three" chunk that
    // is fetched on demand rather than duplicated across the view chunks. The
    // limit is raised because the split is intentional, not a missed optimization.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      output: {
        manualChunks: (id: string): string | null => {
          if (id.includes("node_modules/three")) return "three";
          return null;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
