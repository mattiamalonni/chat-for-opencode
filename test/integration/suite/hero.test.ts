import { join } from "node:path";
import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import * as vscode from "vscode";

/**
 * Captures the README hero from the *real* extension: VS Code is launched with the mock
 * `opencode serve`, the chat is driven through actual messages, and the whole window is
 * screenshotted over CDP. Nothing about the VS Code chrome is recreated here, so the image
 * cannot drift from the shipped UI.
 *
 * Run with `npm run gen:hero`.
 */
describe("README hero", () => {
  const inputSelector = 'body[data-oc-e2e="1"] textarea[aria-label="Message to OpenCode"]';
  let browser: Browser | undefined;

  before(async () => {
    await vscode.commands.executeCommand("opencode.focus");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OC_IT_CDP_PORT ?? "9222"}`);
  });

  after(async () => {
    await browser?.close();
  });

  async function findChat(): Promise<{ page: Page; frame: Frame }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
      for (const page of pages) {
        for (const frame of page.frames()) {
          if (
            await frame
              .locator(inputSelector)
              .count()
              .catch(() => 0)
          )
            return { page, frame };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Could not find the OpenCode webview in the VS Code window");
  }

  async function waitForReply(frame: Frame, text: string): Promise<void> {
    await frame.locator(".conversation .msg.assistant").filter({ hasText: text }).waitFor({ timeout: 30_000 });
    await frame.waitForFunction(
      () => {
        const cards = document.querySelectorAll(".conversation .msg.assistant");
        const last = cards[cards.length - 1];
        return !!last && last.getAttribute("aria-busy") === "false";
      },
      undefined,
      { timeout: 30_000 },
    );
  }

  it("writes docs/images/hero.png", async () => {
    const { page, frame } = await findChat();
    const input = frame.locator(inputSelector);
    await frame.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && !(el as HTMLTextAreaElement).disabled;
      },
      inputSelector,
      { timeout: 15_000 },
    );

    // Show a real source file next to the chat.
    const workspace = process.env.OC_IT_WORKSPACE!;
    const doc = await vscode.workspace.openTextDocument(join(workspace, "src", "app.ts"));
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("opencode.focus");

    // One complete turn: a prompt with a file mention and a streamed, meaningful answer.
    await input.fill("Explain @src/app.ts — how does it start the local server?");
    await input.press("Enter");
    await waitForReply(frame, "source of truth");

    // Test-only chrome: the mock server fails the contract smoke test, so hide that banner.
    const dismiss = frame.locator(".banner.warning button.dismiss");
    if (await dismiss.count()) await dismiss.click();
    await vscode.commands.executeCommand("notifications.clearAll");

    // Leave a slash command open in the composer to show the command picker.
    await input.fill("/");
    await frame.getByRole("option", { name: /mock-init/ }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);

    const out = join(__dirname, "../../../../docs/images/hero.png");
    await page.screenshot({ path: out });
    console.log(`Hero screenshot written to ${out}`);
  });
});
