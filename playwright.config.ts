import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke-test config: builds the real app (`tsc --noEmit && vite build`) then
 * serves the production bundle via `vite preview` on a fixed port. Only files
 * matching `*.spec.ts` are picked up, so the vitest `*.test.ts` unit suites are
 * left to `vitest`.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: false,
  workers: 1,
  // One retry: headless SwiftShader renders these 3D scenes at ~2fps (61fps on
  // real GPU), so heavy capture specs are environment-sensitive — a retry
  // absorbs load/thermal hiccups while real regressions still fail twice.
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4178",
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4178 --strictPort",
    url: "http://localhost:4178",
    reuseExistingServer: true,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
