import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/ui",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  reporter: [["list"]],
  use: { browserName: "chromium", viewport: { width: 380, height: 760 } },
});
