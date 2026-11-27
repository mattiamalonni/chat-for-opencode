import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { STRINGS } from "../../src/shared/strings";

const HARNESS = "file://" + join(__dirname, "harness.html");

async function host(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, "*"), msg as Record<string, unknown>);
}

async function boot(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __posted?: { type: string }[] }).__posted?.some((m) => m.type === "ready") ?? false),
    )
    .toBe(true);
  await host(page, { type: "init", strings: { ...STRINGS }, platform: "windows", folders: [], issuesUrl: "" });
  await host(page, { type: "connection", status: "connected" });
  await host(page, {
    type: "catalog",
    models: [{ id: "m", modelID: "m", providerID: "p", name: "M", enabled: true, variants: [], limit: { context: 1000, output: 100 } }],
    agents: [],
    skills: [],
  });
}

/**
 * Lightweight accessibility-tree checks. They do not replace a screen reader, but they catch
 * regressions in the labels and roles the real assistive technologies rely on.
 */
test.describe("accessibility tree", () => {
  test("the composer exposes a labelled textbox and labelled icon buttons", async ({ page }) => {
    await boot(page);
    const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
    await expect(input).toBeVisible();
    const snapshot = await page.locator(".composer").ariaSnapshot();
    expect(snapshot).toContain(`textbox "${STRINGS.inputLabel}"`);
    expect(snapshot).toContain(`button "${STRINGS.send}"`);
  });

  test("header icon tooltips open below, so they are not clipped off-screen", async ({ page }) => {
    await boot(page);
    for (const name of [STRINGS.exportConversation, STRINGS.searchMessages]) {
      const button = page.getByRole("button", { name });
      const box = await button.boundingBox();
      expect(box?.y ?? 999).toBeLessThan(60); // the header is at the very top of the view
      await button.hover();
      const style = await button.evaluate((el) => {
        const s = getComputedStyle(el, "::after");
        return { top: s.top, visibility: s.visibility, opacity: s.opacity };
      });
      // Chrome resolves `bottom` to a used value even when it is `auto`, so check `top`: a tooltip
      // opening above the button would have a negative top and be clipped by the viewport.
      expect(parseFloat(style.top)).toBeGreaterThan(0);
      expect(parseFloat(style.top)).toBeLessThan(200);
      expect(style.visibility).toBe("visible");
      expect(style.opacity).toBe("1");
    }
  });

  test("muted text keeps full opacity and high-contrast themes keep every border", async ({ page }) => {
    await boot(page);
    const hint = page.locator(".welcome-hint").first();
    await expect(hint).toBeVisible();
    expect(await hint.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--vscode-contrastBorder", "rgb(255, 0, 0)");
      document.body.classList.add("vscode-high-contrast");
    });
    for (const selector of [".composer-box", ".banner", ".welcome-starter", ".welcome-mark"]) {
      if ((await page.locator(selector).count()) === 0) continue;
      // `.composer-box` transitions border-color, so poll until the high-contrast value settles.
      await expect
        .poll(() =>
          page
            .locator(selector)
            .first()
            .evaluate((el) => getComputedStyle(el).borderTopColor),
        )
        .toBe("rgb(255, 0, 0)");
    }
  });

  test("the search toggle's tooltip does not cover the open search bar", async ({ page }) => {
    await boot(page);
    const toggle = page.getByRole("button", { name: STRINGS.searchMessages });
    await toggle.click();
    await toggle.hover();
    expect(await toggle.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");
  });

  test("a permission card exposes its actions as labelled buttons", async ({ page }) => {
    await boot(page);
    await host(page, {
      type: "session",
      session: {
        id: "ses_a11y",
        busy: true,
        messages: [],
        permissions: [
          {
            id: "per_1",
            sessionID: "ses_a11y",
            action: "edit",
            resources: ["src/a.txt"],
            save: ["*"],
            metadata: {},
          },
        ],
        forms: [],
      },
    });
    const card = page.locator(".card.permission");
    await expect(card).toBeVisible();
    const snapshot = await card.ariaSnapshot();
    expect(snapshot).toContain(`button "${STRINGS.permissionAllowOnce}"`);
    expect(snapshot).toContain(`button "${STRINGS.permissionAllowAlways}"`);
    expect(snapshot).toContain(`button "${STRINGS.permissionReject}"`);
  });
});
