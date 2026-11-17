import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ServerEvent } from "../../src/shared/api";
import type { HostMessage, WebviewMessage } from "../../src/shared/protocol";
import { STRINGS } from "../../src/shared/strings";

const HARNESS = "file://" + join(__dirname, "harness.html");
const SHOTS = join(__dirname, "screenshots");
const ISSUES_URL = "https://github.com/mattiamalonni/chat-for-opencode/issues";

function fixture(name: string): ServerEvent[] {
  return readFileSync(join(__dirname, "../fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ServerEvent);
}

const S1 = "ses_e1a6de108ffeUoLnIxsC0Iz3qR";
const S2 = "ses_e1a6c6a18ffeykSYEWYa5gpP3I";
const S3 = "ses_e1a69c3cbffe81j4RaR5lg6YJH";

const MODELS = [
  { id: "hy4-flash-free", modelID: "hy4-flash-free", providerID: "opencode", name: "Hy4 flash Free", enabled: true, variants: [{ id: "none" }, { id: "high" }], limit: { context: 1048576, output: 65536 } },
  { id: "claude-sonnet-5.5", modelID: "claude-sonnet-5.5", providerID: "github-copilot", name: "Claude Sonnet 5.5", enabled: true, variants: [], limit: { context: 200000, output: 64000 } },
];
const AGENTS = [
  { id: "build", name: "Build", description: "The default agent.", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", description: "Read-only planning agent.", mode: "primary", hidden: false },
];

async function host(page: Page, msg: HostMessage): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, "*"), msg as unknown as Record<string, unknown>);
}

async function posted(page: Page): Promise<WebviewMessage[]> {
  return page.evaluate(() => (window as unknown as { __posted: WebviewMessage[] }).__posted);
}

async function lastPosted(page: Page, type: WebviewMessage["type"]): Promise<WebviewMessage | undefined> {
  return (await posted(page)).filter((m) => m.type === type).at(-1);
}

async function boot(page: Page, theme: "dark" | "light" = "dark"): Promise<string[]> {
  const cspErrors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
  });
  page.on("pageerror", (e) => cspErrors.push(String(e)));
  await page.goto(HARNESS);
  if (theme === "light") await page.evaluate(() => document.getElementById("theme")!.setAttribute("href", "theme-light.css"));
  await expect.poll(async () => (await posted(page)).some((m) => m.type === "ready")).toBe(true);
  await host(page, { type: "init", strings: { ...STRINGS }, platform: "windows", folders: [{ uri: "file:///work", name: "work" }], activeFolder: "file:///work", issuesUrl: ISSUES_URL });
  await host(page, { type: "connection", status: "connected" });
  await host(page, { type: "catalog", models: MODELS as never, agents: AGENTS as never, skills: [], selectedModel: { id: "hy4-flash-free", providerID: "opencode" }, selectedAgent: "build" });
  await host(page, { type: "sessions", items: [{ id: S1, title: "Hello world reply", updated: Date.now() - 120_000, busy: false }] });
  await host(page, { type: "session", session: null });
  await host(page, {
    type: "context",
    items: [
      { id: "file:///work/src/app.ts", kind: "file", uri: "file:///work/src/app.ts", label: "app.ts", detail: "src/app.ts" },
      { id: "file:///work/src/app.ts?start=3&end=9", kind: "selection", uri: "file:///work/src/app.ts?start=3&end=9", label: "app.ts:3-9", detail: "src/app.ts" },
    ],
  });
  return cspErrors;
}

async function openSession(page: Page, id: string, events: ServerEvent[]): Promise<void> {
  await host(page, { type: "session", session: { id, busy: false, messages: [], permissions: [], forms: [] } });
  for (const event of events) await host(page, { type: "event", event });
}

test("welcome screen, sending with context and removing context chips", async ({ page }) => {
  const csp = await boot(page);
  await expect(page.getByRole("heading", { name: STRINGS.welcomeTitle })).toBeVisible();
  await expect(page.locator(".chip")).toHaveCount(2);
  await page.screenshot({ path: join(SHOTS, "01-welcome-dark.png") });

  await page.getByRole("button", { name: `${STRINGS.removeContext}: app.ts`, exact: true }).click();
  await expect(page.locator(".chip")).toHaveCount(1);

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("Explain this code");
  await input.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send).toMatchObject({ type: "send", text: "Explain this code" });
  expect(send && "context" in send && send.context.map((c) => c.kind)).toEqual(["selection"]);
  await expect(input).toHaveValue("");
  expect(csp).toEqual([]);
});

test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
  await boot(page);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await expect(input).toHaveValue("line one\nline two");
  expect(await lastPosted(page, "send")).toBeUndefined();
});

test("streams a real recorded conversation with reasoning, markdown and tool cards", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse1.jsonl");
  // Stop in the middle of the reasoning stream.
  const firstDelta = events.findIndex((e) => e.type === "session.reasoning.delta") + 1;
  await openSession(page, S1, events.slice(0, firstDelta));
  // While streaming: stop button visible, reasoning shows "Thinking…"
  await expect(page.getByRole("button", { name: STRINGS.stop })).toBeVisible();
  await expect(page.locator(".reasoning summary")).toContainText(STRINGS.thinking);
  await page.getByRole("button", { name: STRINGS.stop }).click();
  expect(await lastPosted(page, "abort")).toEqual({ type: "abort" });

  for (const event of events.slice(firstDelta)) await host(page, { type: "event", event });
  await expect(page.getByRole("button", { name: STRINGS.send })).toBeVisible();
  await expect(page.locator(".msg.assistant .md").first()).toContainText("hello world");
  // Reasoning is collapsed and expandable.
  const thoughts = page.locator(".reasoning").first();
  await expect(thoughts).not.toHaveAttribute("open", "");
  await thoughts.locator("summary").click();
  await expect(thoughts).toHaveAttribute("open", "");

  const tools = page.locator(".tool");
  await expect(tools).toHaveCount(3);
  await expect(tools.nth(0).locator(".tool-name")).toHaveText("write");
  await expect(tools.nth(0).locator(".tool-summary")).toHaveText("hello.txt");
  await tools.nth(1).locator(".tool-header").click();
  await expect(tools.nth(1).locator(".tool-body")).toContainText("PATH_DOES_NOT_EXIST");
  await expect(tools.nth(1).locator(".tool-header")).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: join(SHOTS, "02-conversation-dark.png"), fullPage: true });
});

test("renders markdown with highlighted code and copies code via the host", async ({ page }) => {
  await boot(page);
  const md = "Here:\n\n```ts\nconst answer: number = 42;\n```\n\n<img src=x onerror=alert(1)> [docs](https://opencode.ai)";
  await openSession(page, "ses_md", [
    { type: "session.step.started", data: { sessionID: "ses_md", assistantMessageID: "m1", agent: "build", model: { id: "x", providerID: "y" } } },
    { type: "session.text.started", data: { sessionID: "ses_md", assistantMessageID: "m1", ordinal: 0 } },
    { type: "session.text.delta", data: { sessionID: "ses_md", assistantMessageID: "m1", ordinal: 0, delta: md } },
    { type: "session.step.ended", data: { sessionID: "ses_md", assistantMessageID: "m1", finish: "stop" } },
  ]);
  await expect(page.locator(".hljs-keyword").first()).toHaveText("const");
  // DOMPurify strips the event handler.
  expect(await page.locator(".md img").getAttribute("onerror")).toBeNull();
  await page.getByRole("button", { name: STRINGS.copy }).click();
  expect(await lastPosted(page, "copy")).toEqual({ type: "copy", text: "const answer: number = 42;" });
  await page.getByRole("link", { name: "docs" }).click();
  expect(await lastPosted(page, "openLink")).toEqual({ type: "openLink", href: "https://opencode.ai" });
});

test("permission requests appear inside the tool card and are never auto-approved", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse3.jsonl");
  const asked = events.findIndex((e) => e.type === "permission.asked");
  await openSession(page, S2, events.slice(0, asked + 1));
  const card = page.getByRole("group", { name: new RegExp(STRINGS.permissionTitle) });
  await expect(card).toBeVisible();
  await expect(page.locator(".tool.attention .card.permission")).toHaveCount(1);
  expect(await lastPosted(page, "permissionReply")).toBeUndefined();
  await page.screenshot({ path: join(SHOTS, "03-permission-dark.png"), fullPage: true });

  await card.getByRole("button", { name: /a\.txt/ }).click();
  expect(await lastPosted(page, "openDiff")).toMatchObject({ type: "openDiff", file: "a.txt", applied: false });

  await card.getByRole("button", { name: STRINGS.permissionAllowOnce }).click();
  const reply = await lastPosted(page, "permissionReply");
  expect(reply).toMatchObject({ sessionId: S2, decision: "once" });
  for (const event of events.slice(asked + 1)) await host(page, { type: "event", event });
  await expect(card).toHaveCount(0);
});

test("question forms render options and submit the answer", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse4.jsonl");
  const created = events.findIndex((e) => e.type === "form.created");
  await openSession(page, S2, events.slice(0, created + 1));
  const form = page.locator("form.card.question");
  await expect(form).toBeVisible();
  await form.getByLabel("Blue").check();
  await page.screenshot({ path: join(SHOTS, "04-question-dark.png"), fullPage: true });
  await form.getByRole("button", { name: STRINGS.submit }).click();
  expect(await lastPosted(page, "formReply")).toMatchObject({ answer: { q0: "Blue" } });
});

test("todo list from todowrite", async ({ page }) => {
  await boot(page);
  await openSession(page, S3, fixture("real-sse6.jsonl"));
  const panel = page.locator(".panel.todos");
  await expect(panel).toContainText(`${STRINGS.todos} (0/3)`);
  await expect(panel.locator("li")).toHaveCount(3);
});

test("keyboard isolation: VS Code chords stay in the composer, clipboard passes through", async ({ page }) => {
  await boot(page);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  await page.evaluate(() => ((window as unknown as { __windowKeys: string[] }).__windowKeys.length = 0));
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("abc");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("Control+c");
  const keys = await page.evaluate(() => (window as unknown as { __windowKeys: string[] }).__windowKeys);
  expect(keys).not.toContain("Ctrl+j");
  expect(keys).not.toContain("Ctrl+r");
  expect(keys).not.toContain("a");
  expect(keys).toContain("Ctrl+c");
  expect(keys.some((k) => k.toLowerCase() === "ctrl+p")).toBe(true);
});

test("IME composition: Enter confirming a candidate does not send", async ({ page }) => {
  await boot(page);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  await page.evaluate(() => {
    const el = document.querySelector("textarea")!;
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    el.value = "にほん";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "にほん", isComposing: true }));
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(ev, "keyCode", { value: 229 });
    el.dispatchEvent(ev);
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    // WebKit: the confirming Enter can arrive right after compositionend with isComposing=false.
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(await lastPosted(page, "send")).toBeUndefined();
  // After the composition settles, Enter sends.
  await page.waitForTimeout(20);
  await input.press("Enter");
  expect(await lastPosted(page, "send")).toMatchObject({ text: "にほん" });
});

test("@ mentions search files and attach the selection", async ({ page }) => {
  await boot(page);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  await page.keyboard.type("look at @app");
  await expect.poll(async () => (await lastPosted(page, "searchFiles")) as unknown).toEqual({ type: "searchFiles", query: "app" });
  await host(page, {
    type: "fileResults",
    query: "app",
    items: [
      { uri: "file:///work/src/app.ts", name: "app.ts", kind: "file", detail: "src/app.ts" },
      { uri: "file:///work/src/apply.ts", name: "apply.ts", kind: "file", detail: "src/apply.ts" },
    ],
  });
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(input).toHaveAttribute("aria-activedescendant", "mention-0");
  await page.screenshot({ path: join(SHOTS, "05-mention-dark.png") });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("look at @src/apply.ts ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.type("please");
  await page.keyboard.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send && "attachments" in send && send.attachments.map((a) => a.uri)).toEqual(["file:///work/src/apply.ts"]);
});

test("slash commands select skills and preserve other slash commands", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "catalog",
    models: MODELS as never,
    agents: AGENTS as never,
    skills: [{ id: "mock-review", name: "Code review", description: "Review code changes." }],
    selectedModel: { id: "hy4-flash-free", providerID: "opencode" },
    selectedAgent: "build",
  });
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("/mock");
  await expect(page.getByRole("option", { name: /Code review/ })).toBeVisible();
  await page.getByRole("option", { name: /Code review/ }).click();
  await expect(input).toHaveValue("/mock-review ");
  await input.press("Enter");
  expect(await lastPosted(page, "send")).toMatchObject({ type: "send", text: "@mock-review", attachments: [] });

  await input.fill("/unknown command");
  await input.press("Enter");
  expect(await lastPosted(page, "send")).toMatchObject({ type: "send", text: "/unknown command" });
});

test("custom pickers: agent, variant and searchable model (mouse + keyboard)", async ({ page }) => {
  await boot(page);
  expect(await page.locator("select").count()).toBe(0);

  const agent = page.getByRole("button", { name: `${STRINGS.agent}: Build` });
  await agent.click();
  const agentList = page.getByRole("listbox", { name: STRINGS.agent });
  await expect(agentList).toBeVisible();
  await expect(agentList.getByRole("option", { name: /Build/ })).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, "09-agent-picker-dark.png") });
  await agentList.getByRole("option", { name: /Plan/ }).click();
  expect(await lastPosted(page, "setAgent")).toEqual({ type: "setAgent", agent: "plan" });
  await expect(agentList).toHaveCount(0);

  // Keyboard: open with ArrowDown, move, confirm with Enter; Escape closes without changing.
  const variant = page.getByRole("button", { name: new RegExp(`^${STRINGS.variant}:`) });
  await variant.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: STRINGS.variant })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await lastPosted(page, "setModel")).toEqual({ type: "setModel", model: { providerID: "opencode", id: "hy4-flash-free", variant: "high" } });
  await expect(variant).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: STRINGS.variant })).toHaveCount(0);

  await page.getByRole("button", { name: `${STRINGS.model}: Hy4 flash Free` }).click();
  const models = page.getByRole("listbox", { name: STRINGS.model });
  await expect(models.locator(".picker-group")).toHaveText(["github-copilot", "opencode"]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, "10-model-picker-dark.png") });
  await models.getByRole("option", { name: /Claude Sonnet/ }).click();
  expect(await lastPosted(page, "setModel")).toEqual({ type: "setModel", model: { providerID: "github-copilot", id: "claude-sonnet-5.5" } });

  // Clicking outside closes.
  await page.getByRole("button", { name: `${STRINGS.agent}: Build` }).click();
  await page.locator(".conversation").click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole("listbox", { name: STRINGS.agent })).toHaveCount(0);
});

test("model picker search filters when there are many models", async ({ page }) => {
  await boot(page);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, modelID: `m${i}`, providerID: i % 2 ? "alpha" : "beta", name: `Model ${i}`, enabled: true, variants: [] }));
  many.push({ id: "gpt-x", modelID: "gpt-x", providerID: "alpha", name: "GPT X", enabled: true, variants: [] });
  await host(page, { type: "catalog", models: many as never, agents: AGENTS as never, skills: [], selectedModel: { id: "m0", providerID: "beta" }, selectedAgent: "build" });
  await page.getByRole("button", { name: `${STRINGS.model}: Model 0` }).click();
  const search = page.getByRole("combobox", { name: STRINGS.searchModels });
  await expect(search).toBeFocused();
  await page.keyboard.type("gpt");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  expect(await lastPosted(page, "setModel")).toEqual({ type: "setModel", model: { providerID: "alpha", id: "gpt-x" } });
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.model}:`) }).click();
  await page.keyboard.type("zzz");
  await expect(page.locator(".picker-empty")).toHaveText(STRINGS.noModelsFound);
});

test("picker popup stays inside a narrow view", async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 600 });
  await boot(page);
  const variantValue = page.locator(".picker.variant .picker-value");
  await expect(variantValue).toHaveText(STRINGS.defaultVariant);
  expect(await variantValue.evaluate((el: HTMLElement) => el.scrollWidth)).toBeLessThanOrEqual(
    await variantValue.evaluate((el: HTMLElement) => el.clientWidth),
  );
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.variant}:`) }).click();
  const box = await page.locator(".picker-popup").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(260);
});

test("session list: switch and delete with confirmation", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.sessions}:`) }).click();
  const dialog = page.getByRole("dialog", { name: STRINGS.sessions });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "06-sessions-dark.png") });
  await dialog.getByRole("button", { name: /^Hello world reply/ }).click();
  expect(await lastPosted(page, "selectSession")).toEqual({ type: "selectSession", id: S1 });
  await dialog.getByRole("button", { name: `${STRINGS.deleteSession}: Hello world reply` }).click();
  expect(await lastPosted(page, "deleteSession")).toBeUndefined();
  await dialog.getByRole("button", { name: STRINGS.deleteSession, exact: true }).click();
  expect(await lastPosted(page, "deleteSession")).toEqual({ type: "deleteSession", id: S1 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("errors show actionable banners (server missing, provider, interrupted stream)", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "connection",
    status: "error",
    error: { kind: "notInstalled", message: STRINGS["error.notInstalled"], detail: '"opencode" was not found.', actions: ["install", "openSettings", "showLogs"] },
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(STRINGS["error.notInstalled"]);
  await expect(page.getByRole("textbox", { name: STRINGS.inputLabel })).toBeDisabled();
  await page.screenshot({ path: join(SHOTS, "07-error-not-installed-dark.png") });
  await alert.getByRole("button", { name: STRINGS["action.install"] }).click();
  expect(await lastPosted(page, "action")).toEqual({ type: "action", id: "install" });

  await host(page, { type: "connection", status: "reconnecting" });
  await expect(page.getByRole("status").filter({ hasText: STRINGS.reconnecting })).toBeVisible();

  await host(page, { type: "connection", status: "connected" });
  await openSession(page, "ses_err", [
    { type: "session.execution.started", data: { sessionID: "ses_err" } },
    { id: "e1", type: "session.execution.failed", data: { sessionID: "ses_err", error: { type: "provider_auth", message: "Missing API key for provider" } } },
  ]);
  const failure = page.locator(".notice.error");
  await expect(failure).toContainText("Missing API key for provider");
  await failure.getByRole("button", { name: STRINGS["action.login"] }).click();
  expect(await lastPosted(page, "action")).toEqual({ type: "action", id: "login" });

  await openSession(page, S2, fixture("real-sse5.jsonl"));
  await expect(page.locator(".notice.warning").last()).toContainText(STRINGS.interrupted);
});

test("light theme rendering", async ({ page }) => {
  await boot(page, "light");
  const events = fixture("real-sse3.jsonl");
  const asked = events.findIndex((e) => e.type === "permission.asked");
  await openSession(page, S2, events.slice(0, asked + 1));
  await page.screenshot({ path: join(SHOTS, "08-permission-light.png"), fullPage: true });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(248, 248, 248)");
});

test("localized strings from the host are used", async ({ page }) => {
  await boot(page);
  await host(page, { type: "init", strings: { ...STRINGS, send: "Invia", inputLabel: "Messaggio per OpenCode" }, platform: "mac", folders: [], activeFolder: undefined });
  await expect(page.getByRole("button", { name: "Invia" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Messaggio per OpenCode" })).toBeVisible();
});

test("untested OpenCode version shows a dismissible warning", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".banner.warning")).toHaveCount(0);

  await host(page, { type: "connection", status: "connected", version: "2.9.0", compatibility: "untested" });
  const banner = page.locator(".banner.warning");
  await expect(banner).toContainText("2.9.0");
  await expect(banner).toContainText("2.2.7");

  await banner.getByRole("button", { name: STRINGS.dismiss }).click();
  await expect(page.locator(".banner.warning")).toHaveCount(0);
  expect(await lastPosted(page, "dismissCompatibility")).toEqual({ type: "dismissCompatibility", version: "2.9.0" });
  // Dismissal sticks for this version, but a new one warns again.
  await host(page, { type: "connection", status: "connected", version: "2.9.0", compatibility: "untested" });
  await expect(page.locator(".banner.warning")).toHaveCount(0);
  await host(page, { type: "connection", status: "connected", version: "2.10.0", compatibility: "untested" });
  await expect(page.locator(".banner.warning")).toContainText("2.10.0");
  // After a reload the host reports the stored dismissal for that version.
  await host(page, { type: "connection", status: "connected", version: "2.10.0", compatibility: "untested", compatibilityDismissed: true });
  await expect(page.locator(".banner.warning")).toHaveCount(0);
});

test("unsupported OpenCode version shows an error banner with a report link", async ({ page }) => {
  await boot(page);
  await host(page, { type: "connection", status: "connected", version: "3.0.0", compatibility: "unsupported" });
  const banner = page.getByRole("alert").filter({ hasText: "3.0.0" });
  await expect(banner).toContainText("2.2.7");
  await banner.getByRole("button", { name: STRINGS.reportIssue }).click();
  expect(await lastPosted(page, "openLink")).toEqual({
    type: "openLink",
    href: ISSUES_URL,
  });
});

test("model picker shows context windows and the meter shows context usage", async ({ page }) => {
  await boot(page);
  const meter = page.getByRole("img", { name: /^Context:/ });
  await expect(meter).toHaveAttribute("aria-label", "Context: 1M tokens window, usage available after the first reply");

  await page.getByRole("button", { name: `${STRINGS.model}: Hy4 flash Free` }).click();
  const models = page.getByRole("listbox", { name: STRINGS.model });
  await expect(models.getByRole("option", { name: /Claude Sonnet/ }).locator(".picker-meta")).toHaveText("200K200K context window");
  await expect(models.getByRole("option", { name: /Hy4/ }).locator(".picker-meta [aria-hidden]")).toHaveText("1M");
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, "11-model-context-dark.png") });
  await page.keyboard.press("Escape");

  // One step of a real session, then a big one against the 200K model.
  await host(page, { type: "catalog", models: MODELS as never, agents: AGENTS as never, skills: [], selectedModel: { id: "claude-sonnet-5.5", providerID: "github-copilot" }, selectedAgent: "build" });
  await openSession(page, "ses_ctx", [
    { type: "session.step.ended", data: { sessionID: "ses_ctx", assistantMessageID: "m1", finish: "stop", tokens: { input: 324, output: 3, reasoning: 17, cache: { read: 8192, write: 0 } } } },
  ]);
  await expect(meter).toHaveAttribute("aria-label", "Context: 8.5K of 200K tokens used (4%)");
  await expect(meter.locator(".context-percent")).toHaveText("4%");
  await host(page, {
    type: "event",
    event: { type: "session.step.ended", data: { sessionID: "ses_ctx", assistantMessageID: "m2", finish: "stop", tokens: { input: 2000, output: 1000, reasoning: 0, cache: { read: 180000, write: 0 } } } },
  });
  await expect(meter).toHaveClass(/critical/);
  await expect(meter.locator(".context-percent")).toHaveText("92%");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "12-context-meter-dark.png"), clip: { x: 0, y: 700, width: 380, height: 60 } });
});

test("question options stack title above description in one column", async ({ page }) => {
  await boot(page);
  const form = {
    id: "frm_long",
    sessionID: "ses_q",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Direzione dei nomi",
        description: "Quale famiglia di nomi vuoi per i cinque mondi?",
        custom: true,
        options: [
          { value: "a", label: "Parole · Numeri · Suoni · Ore · Forme (Recommended)", description: "Cinque sostantivi plurali, italiani, concreti: dicono cosa trovi dentro, restano corti nella nav." },
          { value: "b", label: "Parla! · Conta! · Scrivi! · Tic Tac! · Pensa!", description: "Nomi-azione, giocosi e da gridare: più personalità, ma meno espliciti sul contenuto." },
          { value: "c", label: "Solo togliere 'Little'", description: "English · Math · Italiano · Orologio · Logica. Rischio zero, ma nessun nome nuovo." },
        ],
      },
    ],
  };
  await host(page, { type: "session", session: { id: "ses_q", busy: true, messages: [], permissions: [], forms: [form as never] } });
  const options = page.locator("form.card.question .option-text");
  await expect(options).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const label = await options.nth(i).locator(".option-label").boundingBox();
    const desc = await options.nth(i).locator(".field-desc").boundingBox();
    expect(desc!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
    expect(Math.abs(desc!.x - label!.x)).toBeLessThan(1);
  }
  await page.getByText("Solo togliere 'Little'").click();
  await page.getByRole("button", { name: STRINGS.submit }).click();
  expect(await lastPosted(page, "formReply")).toMatchObject({ answer: { q0: "c" } });
  await page.screenshot({ path: join(SHOTS, "13-question-long-dark.png"), fullPage: true });
});
