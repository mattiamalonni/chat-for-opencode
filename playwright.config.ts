import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/ui",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    // Never open a browser/server on CI; locally open the report only when a run fails.
    ["html", { open: process.env.CI ? "never" : "on-failure" }],
  ],
  use: {
    browserName: "chromium",
    viewport: { width: 380, height: 760 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
