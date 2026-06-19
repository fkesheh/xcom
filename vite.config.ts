import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  server: { port: 5173, open: false },
  build: { target: "es2022", outDir: "dist" },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
