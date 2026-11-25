import { chromium, type Browser, type Frame } from "@playwright/test";
import * as vscode from "vscode";

/**
 * The last manual gap: real clicks in the real webview AND a real model provider.
 * Run with `npm run test:integration:real:e2e` (uses your configured default model).
 */
describe("real webview + embedded SDK", () => {
  const inputSelector = 'body[data-oc-e2e="1"] textarea[aria-label="Message to OpenCode"]';
  let browser: Browser | undefined;

  before(async () => {
    await vscode.commands.executeCommand("opencode.chatView.focus");
    const port = process.env.OC_IT_CDP_PORT ?? "9222";
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  });

  after(async () => {
    await browser?.close();
  });

  async function webview(): Promise<Frame> {
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
            return frame;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Could not find the OpenCode webview in the VS Code window");
  }

  it("types a prompt in the real webview and receives a real streamed reply", async () => {
    const frame = await webview();
    const input = frame.locator(inputSelector);
    await frame.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && !(el as HTMLTextAreaElement).disabled;
      },
      inputSelector,
      { timeout: 60_000 },
    );
    await input.fill("Reply with exactly the single word: pong. No tools.");
    await input.press("Enter");

    await frame.locator(".conversation .msg.user .user-text", { hasText: "pong" }).waitFor({ timeout: 60_000 });
    await frame.locator(".conversation .msg.assistant").filter({ hasText: "pong" }).waitFor({ timeout: 120_000 });
  });
});
