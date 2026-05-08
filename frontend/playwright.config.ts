import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for murder-ide-v2 e2e visual tests.
 *
 * Run against an already-running server:
 *   npx playwright test
 *
 * The server must be running on localhost:3928 (or set MURDER_URL).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: process.env.MURDER_URL || "http://localhost:3928",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1400, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
