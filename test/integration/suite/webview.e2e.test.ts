import { chromium, type Browser, type Frame } from "@playwright/test";
import * as vscode from "vscode";

/**
 * Drives the *real* Preact webview inside VS Code. The other integration suites talk to the
 * ChatController through its message API and the UI suite uses a fake host; this one attaches to
 * the extension host's Chromium over CDP, so clicks, keyboard isolation and the permission cards
 * are exercised end to end against the mock `opencode serve`.
 *
 * Run with `npm run test:integration:e2e` (adds --remote-debugging-port to the VS Code launch).
 */
describe("webview inside VS Code", () => {
  const inputSelector = 'body[data-oc-e2e="1"] textarea[aria-label="Message to OpenCode"]';
  let browser: Browser | undefined;

  before(async () => {
    await vscode.commands.executeCommand("opencode.focus");
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
          if (await frame.locator(inputSelector).count().catch(() => 0)) return frame;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Could not find the OpenCode webview in the VS Code window");
  }

  async function readyInput(frame: Frame) {
    const input = frame.locator(inputSelector);
    await frame.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && !(el as HTMLTextAreaElement).disabled;
      },
      inputSelector,
      { timeout: 60_000 },
    );
    return input;
  }

  it("types a prompt in the real webview and streams the reply", async () => {
    const frame = await webview();
    const input = await readyInput(frame);
    await input.fill("pong from the real webview");
    await input.press("Enter");

    await frame.locator(".conversation .msg.user .user-text", { hasText: "pong from the real webview" }).waitFor({ timeout: 30_000 });
    await frame.locator(".conversation .msg.assistant").filter({ hasText: "Echo:" }).waitFor({ timeout: 30_000 });
    // Let the post-turn reconcile finish before another test starts a new turn.
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll(".conversation .msg.assistant");
      const last = cards[cards.length - 1];
      return !!last && last.getAttribute("aria-busy") === "false";
    }, undefined, { timeout: 30_000 });
  });

  it("approves an inline permission by clicking its card", async () => {
    const frame = await webview();
    // A fresh session avoids racing the previous turn's reconcile, which would replace the card.
    await vscode.commands.executeCommand("opencode.newSession");
    const input = await readyInput(frame);
    await input.fill("[permission] edit please");
    await input.press("Enter");

    const allow = frame.locator(".card.permission button.primary");
    await allow.waitFor({ timeout: 45_000 });
    await allow.click();
    await frame.locator(".tool.completed").first().waitFor({ timeout: 30_000 });
  });
});
