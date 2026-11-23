/**
 * Playwright fixtures shared by the UI suites.
 *
 * With `OC_COVERAGE=1`, Chromium's precise JavaScript coverage is collected for every test and
 * written to `coverage/ui/*.json`. `scripts/ui-coverage.mjs` maps those V8 ranges back through the
 * esbuild source map, so webview modules stop being invisible to the coverage report.
 * The fixture is a no-op in a normal `npm test` run (no extra CDP sessions, no artifacts).
 */
import { test as base } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ScriptCoverage {
  url: string;
  functions: Array<{
    functionName: string;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

export const test = base.extend<{ webviewCoverage: void }>({
  webviewCoverage: [
    async ({ page }, use, testInfo) => {
      if (!process.env.OC_COVERAGE) {
        await use();
        return;
      }
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      try {
        await use();
      } finally {
        const { result } = (await cdp.send("Profiler.takePreciseCoverage")) as { result: ScriptCoverage[] };
        mkdirSync(join("coverage", "ui"), { recursive: true });
        writeFileSync(join("coverage", "ui", `${testInfo.testId}.json`), JSON.stringify(result));
        await cdp.send("Profiler.disable");
        await cdp.detach();
      }
    },
    { auto: true },
  ],
});
