import * as assert from "node:assert";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Drives the real status bar hover: clicking the item pins the very same hover open through the
 * built-in `workbench.action.showHover` command. Run with
 * `OC_IT_E2E=1 OC_IT_SUITE=statusbar.e2e.test.js npm run test:integration:e2e`.
 */
describe("status bar hover", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  before(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OC_IT_CDP_PORT ?? "9222"}`);
    page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("Could not attach to the VS Code window");
  });

  after(async () => {
    await browser?.close();
  });

  const hover = () => page!.locator(".monaco-hover, .hover");

  it("keeps the same hover open after a click and moving the mouse away", async () => {
    const item = page!.locator('.statusbar-item:has(a[aria-label*="OpenCode"])').first();
    await item.waitFor({ timeout: 30_000 });

    await item.click();
    // The click handler focuses the hover through `workbench.action.showHover`.
    await hover().filter({ hasText: "OpenCode" }).first().waitFor({ timeout: 10_000 });

    await page!.mouse.move(5, 5);
    await page!.waitForTimeout(2_500);
    assert.ok((await hover().count()) > 0, "hover is still visible after the mouse moved away");
    assert.match((await hover().allTextContents()).join(" | "), /OpenCode/);
  });
});
