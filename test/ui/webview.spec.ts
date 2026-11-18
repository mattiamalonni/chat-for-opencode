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
  { id: "reviewer", name: "Reviewer", description: "Reviews code.", mode: "primary", hidden: false },
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
  await host(page, { type: "sessions", items: [{ id: S1, title: "Hello world reply", updated: Date.now() - 120_000, busy: false, needsInput: false }] });
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

test("welcome screen, active file is opt-in and selections are attached", async ({ page }) => {
  const csp = await boot(page);
  await expect(page.getByRole("heading", { name: STRINGS.welcomeTitle })).toBeVisible();
  await expect(page.locator(".chip")).toHaveCount(2);
  // File-type icons: app.ts is code, the range is a selection.
  await expect(page.locator(".chip .file-icon.code")).toHaveCount(1);
  // The active file is shown but not attached until the user adds it.
  const addFile = page.getByRole("button", { name: `${STRINGS.addContext}: app.ts`, exact: true });
  await expect(addFile).toBeVisible();
  await expect(page.getByRole("button", { name: `${STRINGS.removeContext}: app.ts:3-9`, exact: true })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "01-welcome-dark.png") });

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("Explain this code");
  await input.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send).toMatchObject({ type: "send", text: "Explain this code" });
  expect(send && "context" in send && send.context.map((c) => c.kind)).toEqual(["selection"]);
  await expect(input).toHaveValue("");
  expect(csp).toEqual([]);
});

test("adding the active file and removing a selection toggles the context chips", async ({ page }) => {
  await boot(page);
  const chip = page.locator(".chip").first();

  // Adding the file keeps the chip visible but marks it as attached.
  await page.getByRole("button", { name: `${STRINGS.addContext}: app.ts`, exact: true }).click();
  await expect(chip).not.toHaveClass(/off/);
  await expect(page.getByRole("button", { name: `${STRINGS.removeContext}: app.ts`, exact: true })).toBeVisible();

  // Removing the selection keeps its chip too.
  await page.getByRole("button", { name: `${STRINGS.removeContext}: app.ts:3-9`, exact: true }).click();
  await expect(page.getByRole("button", { name: `${STRINGS.addContext}: app.ts:3-9`, exact: true })).toBeVisible();
  await expect(page.locator(".chip")).toHaveCount(2);

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("Only the file");
  await input.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send && "context" in send && send.context.map((c) => c.kind)).toEqual(["file"]);
});

test("dropping a file from outside shows an overlay and attaches it", async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///Users/me/notes.txt");
    window.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator(".drop-overlay")).toContainText(STRINGS.dropFilesOverlay);

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///Users/me/notes.txt");
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator(".drop-overlay")).toHaveCount(0);
  // The drop handler is async (it reads file content), so wait for the post instead of reading once.
  await expect.poll(async () => (await lastPosted(page, "dropFiles")) as unknown).toMatchObject({
    files: [{ name: "notes.txt", uri: "file:///Users/me/notes.txt" }],
  });
  await expect(page.locator(".chip").filter({ hasText: "notes.txt" })).toHaveCount(1);

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("Summarize this");
  await input.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send && "attachments" in send && send.attachments.map((a) => a.name)).toContain("notes.txt");
});

test("a dropped file without a path is sent to the host as content", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "clip.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  // Reading a File's bytes is async, so the dropFiles post can land after this evaluate.
  await expect.poll(async () => (await lastPosted(page, "dropFiles")) as unknown).toMatchObject({ files: [{ name: "clip.txt", base64: "aGVsbG8=" }] });
  await expect(page.locator(".chip").filter({ hasText: "clip.txt" })).toHaveCount(1);
});

test("pasting an image into the prompt attaches it", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" }));
    document.querySelector("textarea.input")!.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
    );
  });
  // Reading the File's bytes is async, so the dropFiles post can land after this evaluate.
  await expect.poll(async () => (await lastPosted(page, "dropFiles")) as unknown).toMatchObject({
    files: [{ name: "shot.png", base64: "iVBORw0KGgo=", mime: "image/png" }],
  });
  await expect(page.locator(".chip").filter({ hasText: "shot.png" })).toHaveCount(1);

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("Describe this screenshot");
  await input.press("Enter");
  const send = await lastPosted(page, "send");
  expect(send && "attachments" in send && send.attachments.map((a) => a.name)).toContain("shot.png");
});

test("pasting plain text is not treated as a file", async ({ page }) => {
  await boot(page);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  // A synthetic paste cannot insert text, but dispatchEvent reports whether we cancelled it:
  // plain text must keep the browser's default paste (only file pastes are intercepted).
  const notCancelled = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello world");
    return document.querySelector("textarea.input")!.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
    );
  });
  expect(notCancelled).toBe(true);
  expect(await lastPosted(page, "dropFiles")).toBeUndefined();
});

test("the folder button asks the host to open the native file picker", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: STRINGS.pickFiles }).click();
  expect(await lastPosted(page, "pickFiles")).toMatchObject({ type: "pickFiles" });
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

test("Up/Down in the composer recall previously sent prompts", async ({ page }) => {
  await boot(page);
  await openSession(page, S1, [
    {
      type: "session.inbox.enqueued",
      data: { sessionID: S1, inboxID: "msg_old", item: { type: "user", payload: { text: "first prompt" } } },
    },
    {
      type: "session.inbox.enqueued",
      data: { sessionID: S1, inboxID: "msg_last", item: { type: "user", payload: { text: "second prompt" } } },
    },
  ]);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await expect(page.locator(".msg.user .user-text")).toHaveText(["first prompt", "second prompt"]);

  await input.press("ArrowUp");
  await expect(input).toHaveValue("second prompt");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");
  // Oldest prompt: another Up stays put instead of clearing the field.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("second prompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");

  // Starting from a draft, Down after the newest prompt restores that draft.
  await input.fill("unfinished draft");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second prompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("unfinished draft");
});

test("modified Up/Down keys move the caret instead of recalling prompts", async ({ page }) => {
  await boot(page);
  await openSession(page, S1, [
    {
      type: "session.inbox.enqueued",
      data: { sessionID: S1, inboxID: "msg_old", item: { type: "user", payload: { text: "first prompt" } } },
    },
  ]);
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("draft in progress");
  // Cmd/Ctrl+Up are standard caret shortcuts, not prompt-history navigation.
  await input.press("Meta+ArrowUp");
  await expect(input).toHaveValue("draft in progress");
  await input.press("Control+ArrowUp");
  await expect(input).toHaveValue("draft in progress");
  await input.press("Alt+ArrowDown");
  await expect(input).toHaveValue("draft in progress");
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

  // Tool calls keep the order the model produced them in, around their narration.
  const tools = page.locator(".tool");
  await expect(tools).toHaveCount(3);
  await expect(tools.nth(0).locator(".tool-name")).toHaveText("write");
  await expect(tools.nth(0).locator(".tool-summary")).toHaveText("hello.txt");
  await tools.nth(1).locator(".tool-header").click();
  await expect(tools.nth(1).locator(".tool-body")).toContainText("PATH_DOES_NOT_EXIST");
  await expect(tools.nth(1).locator(".tool-header")).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: join(SHOTS, "02-conversation-dark.png"), fullPage: true });
});

test("keeps thoughts and tools in production order and groups adjacent calls", async ({ page }) => {
  await boot(page);
  const sid = "ses_order";
  const m1 = { sessionID: sid, assistantMessageID: "m1" };
  const m2 = { sessionID: sid, assistantMessageID: "m2" };
  const tool = (base: typeof m1, id: string, name: string, input: Record<string, unknown>): ServerEvent[] => [
    { type: "session.tool.input.started", data: { ...base, id, name } },
    { type: "session.tool.input.ended", data: { ...base, id, text: JSON.stringify(input) } },
    { type: "session.tool.called", data: { ...base, id, input } },
    { type: "session.tool.success", data: { ...base, id, content: [{ type: "text", text: "ok" }] } },
  ];
  await openSession(page, sid, [
    { type: "session.step.started", data: { ...m1, agent: "build" } },
    { type: "session.reasoning.started", data: { ...m1, ordinal: 0 } },
    { type: "session.reasoning.ended", data: { ...m1, ordinal: 0, text: "first thought" } },
    { type: "session.text.started", data: { ...m1, ordinal: 0 } },
    { type: "session.text.ended", data: { ...m1, ordinal: 0, text: "checking files" } },
    ...tool(m1, "t1", "read", { path: "a.txt" }),
    ...tool(m1, "t2", "read", { path: "b.txt" }),
    { type: "session.step.ended", data: { ...m1, finish: "tool-calls" } },
    { type: "session.step.started", data: { ...m2, agent: "build" } },
    { type: "session.reasoning.started", data: { ...m2, ordinal: 0 } },
    { type: "session.reasoning.ended", data: { ...m2, ordinal: 0, text: "second thought" } },
    ...tool(m2, "t3", "shell", { command: "ls" }),
    { type: "session.step.ended", data: { ...m2, finish: "tool-calls" } },
    { type: "session.execution.succeeded", data: { sessionID: sid } },
  ]);

  // Both calls of the first step share one accordion...
  const group = page.locator(".tool-group");
  await expect(group).toHaveCount(1);
  await group.locator(".tool-group-header").click();
  await expect(group.locator(".tool")).toHaveCount(2);
  // ...but the next step's call stays after its own thought.
  const standalone = page.locator(".conversation > .tool");
  await expect(standalone).toHaveCount(1);
  await expect(standalone.locator(".tool-name")).toHaveText("shell");

  const firstText = await page.locator(".md").first().boundingBox();
  const groupBox = await group.boundingBox();
  const secondThought = await page.locator(".reasoning").nth(1).boundingBox();
  const standaloneBox = await standalone.boundingBox();
  expect(firstText!.y).toBeLessThan(groupBox!.y);
  expect(groupBox!.y).toBeLessThan(secondThought!.y);
  expect(secondThought!.y).toBeLessThan(standaloneBox!.y);
});

test("a new prompt follows the latest message even after scrolling up", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 });
  await boot(page);
  await openSession(page, S1, fixture("real-sse1.jsonl"));
  const conversation = page.locator(".conversation");
  await expect.poll(async () => conversation.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await conversation.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const jump = page.getByRole("button", { name: STRINGS.jumpToLatest });
  await expect(jump).toBeVisible();

  await host(page, {
    type: "event",
    event: {
      type: "session.inbox.enqueued",
      data: { sessionID: S1, inboxID: "msg_follow", item: { type: "user", payload: { text: "a second prompt" } } },
    },
  });
  await expect.poll(async () => conversation.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
  await expect(jump).toHaveCount(0);
  await expect(page.locator(".msg.user .user-text").last()).toHaveText("a second prompt");
});

test("a live prompt with a file attachment renders without crashing", async ({ page }) => {
  await boot(page);
  await openSession(page, S1, []);
  await host(page, {
    type: "event",
    event: {
      type: "session.inbox.enqueued",
      data: {
        sessionID: S1,
        inboxID: "msg_file",
        item: {
          type: "user",
          payload: {
            text: "What is in this file?",
            // Live attachments carry the location under `source`, not at the top level.
            files: [
              { data: "YQo=", mime: "text/plain", source: { type: "uri", uri: "file:///work/src/app.ts" }, name: "app.ts" },
            ],
          },
        },
      },
    },
  });
  await expect(page.locator(".msg.user .user-text").last()).toHaveText("What is in this file?");
  await expect(page.locator(".msg.user .chip")).toHaveText(["app.ts"]);
  await expect(page.getByText(STRINGS.crashBody)).toHaveCount(0);
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

test("plain-text file references open at the exact line", async ({ page }) => {
  await boot(page);
  const sid = "ses_refs";
  await openSession(page, sid, [
    { type: "session.step.started", data: { sessionID: sid, assistantMessageID: "m1", agent: "build" } },
    { type: "session.text.started", data: { sessionID: sid, assistantMessageID: "m1", ordinal: 0 } },
    {
      type: "session.text.delta",
      data: {
        sessionID: sid,
        assistantMessageID: "m1",
        ordinal: 0,
        delta: "Fix in src/app.ts:42, then see foo.ts#L7. Inline code `bar.ts:3` stays text.",
      },
    },
    { type: "session.step.ended", data: { sessionID: sid, assistantMessageID: "m1", finish: "stop" } },
  ]);
  const md = page.locator(".msg.assistant .md").first();
  const refs = md.locator("a.file-ref");
  // Inline code is skipped; the two prose references are clickable.
  await expect(refs).toHaveCount(2);
  await expect(refs.nth(0)).toHaveText("src/app.ts:42");
  await expect(md.locator("code")).toHaveText("bar.ts:3");

  await refs.nth(0).click();
  expect(await lastPosted(page, "openFile")).toEqual({ type: "openFile", path: "src/app.ts:42" });
  await refs.nth(1).click();
  expect(await lastPosted(page, "openFile")).toEqual({ type: "openFile", path: "foo.ts:7" });
});

test("numbers and versions in a reply are not turned into file links", async ({ page }) => {
  await boot(page);
  const sid = "ses_numbers";
  await openSession(page, sid, [
    { type: "session.step.started", data: { sessionID: sid, assistantMessageID: "m1", agent: "build" } },
    { type: "session.text.started", data: { sessionID: sid, assistantMessageID: "m1", ordinal: 0 } },
    {
      type: "session.text.delta",
      data: {
        sessionID: sid,
        assistantMessageID: "m1",
        ordinal: 0,
        delta: "Ho cambiato il timer da 0.25s a 0.30s (v2.10.0). Il file è src/app.ts:42.",
      },
    },
    { type: "session.step.ended", data: { sessionID: sid, assistantMessageID: "m1", finish: "stop" } },
  ]);
  const refs = page.locator(".msg.assistant .md").first().locator("a.file-ref");
  await expect(refs).toHaveCount(1);
  await expect(refs).toHaveText("src/app.ts:42");
});

test("tool, permission and changed-file paths open the file with one click", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse3.jsonl");
  const asked = events.findIndex((e) => e.type === "permission.asked");
  await openSession(page, S2, events.slice(0, asked + 1));
  const card = page.getByRole("group", { name: new RegExp(STRINGS.permissionTitle) });

  await card.locator(".resources .resource-link").first().click();
  expect(await lastPosted(page, "openFile")).toEqual({ type: "openFile", path: "a.txt" });

  await page.locator(".tool.attention .tool-body .tool-open-file").first().click();
  expect(await lastPosted(page, "openFile")).toEqual({ type: "openFile", path: "a.txt" });

  await card.locator(".file-list .file-open").first().click();
  expect(await lastPosted(page, "openFile")).toEqual({ type: "openFile", path: "a.txt" });

  // The original diff action still works next to the new button.
  await card.locator(".file-row").click();
  expect(await lastPosted(page, "openDiff")).toMatchObject({ type: "openDiff", file: "a.txt" });
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

  await card.locator(".file-row").click();
  expect(await lastPosted(page, "openDiff")).toMatchObject({ type: "openDiff", file: "a.txt", applied: false });

  await card.getByRole("button", { name: STRINGS.permissionAllowOnce }).click();
  const reply = await lastPosted(page, "permissionReply");
  expect(reply).toMatchObject({ sessionId: S2, decision: "once" });
  for (const event of events.slice(asked + 1)) await host(page, { type: "event", event });
  await expect(card).toHaveCount(0);
});

test("a failed permission reply re-enables the card for a retry", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse3.jsonl");
  const asked = events.findIndex((e) => e.type === "permission.asked");
  await openSession(page, S2, events.slice(0, asked + 1));
  const card = page.getByRole("group", { name: new RegExp(STRINGS.permissionTitle) });
  const allow = card.getByRole("button", { name: STRINGS.permissionAllowOnce });

  await allow.click();
  await expect(allow).toBeDisabled();
  const requestId = (events[asked].data as { id: string }).id;
  // A failed reply produces only a notice tagged with the card, never a `permission.replied`.
  await host(page, {
    type: "notice",
    error: { kind: "requestFailed", message: "Request failed", actions: [], target: { kind: "permission", id: requestId } },
  });
  await expect(allow).toBeEnabled();
  await allow.click();
  expect((await posted(page)).filter((m) => m.type === "permissionReply")).toHaveLength(2);
});

test("a failed form reply re-enables submit for a retry", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse4.jsonl");
  const created = events.findIndex((e) => e.type === "form.created");
  await openSession(page, S2, events.slice(0, created + 1));
  const form = page.locator("form.card.question");
  const submit = form.getByRole("button", { name: STRINGS.submit });
  await form.getByLabel("Blue").check();

  await submit.click();
  await expect(submit).toBeDisabled();
  const formId = (events[created].data as { form: { id: string } }).form.id;
  await host(page, {
    type: "notice",
    error: { kind: "requestFailed", message: "Request failed", actions: [], target: { kind: "form", id: formId } },
  });
  await expect(submit).toBeEnabled();
  await submit.click();
  expect((await posted(page)).filter((m) => m.type === "formReply")).toHaveLength(2);
});

test("the composer toggles auto-approval for the current chat", async ({ page }) => {
  await boot(page);
  await openSession(page, S1, []);
  const toggle = page.getByRole("button", { name: STRINGS.autoApprove });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  expect(await lastPosted(page, "setAutoApprove")).toEqual({ type: "setAutoApprove", enabled: true });
  await host(page, { type: "autoApprove", enabled: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("data-tooltip", STRINGS.autoApproveOn);
});

test("question forms render options and submit the answer", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse4.jsonl");
  const created = events.findIndex((e) => e.type === "form.created");
  await openSession(page, S2, events.slice(0, created + 1));
  const form = page.locator("form.card.question");
  await expect(form).toBeVisible();
  // The raw JSON input is redundant while the friendly question is pending.
  await expect(page.locator(".tool:has(form.card.question) .tool-pre")).toHaveCount(0);
  await form.getByLabel("Blue").check();
  await page.screenshot({ path: join(SHOTS, "04-question-dark.png"), fullPage: true });
  await form.getByRole("button", { name: STRINGS.submit }).click();
  expect(await lastPosted(page, "formReply")).toMatchObject({ answer: { q0: "Blue" } });
});

test("cancelling a question unlocks the composer", async ({ page }) => {
  await boot(page);
  const events = fixture("real-sse4.jsonl");
  const created = events.findIndex((e) => e.type === "form.created");
  await openSession(page, S2, events.slice(0, created + 1));
  await expect(page.getByRole("button", { name: STRINGS.stop })).toBeVisible();

  const form = page.locator("form.card.question");
  await form.getByRole("button", { name: STRINGS.cancel }).click();
  const formId = (events[created].data as { form: { id: string } }).form.id;
  expect(await lastPosted(page, "formCancel")).toMatchObject({ formId });

  // The server may answer with only `form.cancelled` and no terminal execution event.
  await host(page, { type: "event", event: { type: "form.cancelled", data: { id: formId, sessionID: S2 } } });
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("button", { name: STRINGS.send })).toBeVisible();
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

test("Cmd/Ctrl+N starts a new session only while the chat has focus", async ({ page }) => {
  await boot(page); // init platform: windows
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.click();
  await page.evaluate(() => ((window as unknown as { __windowKeys: string[] }).__windowKeys.length = 0));
  await page.keyboard.press("Control+n");
  expect(await lastPosted(page, "newSession")).toEqual({ type: "newSession" });
  // The VS Code preload listens in the bubble phase: the chord must not reach the workbench,
  // otherwise it would run "File: New Untitled File" as well.
  expect(await page.evaluate(() => (window as unknown as { __windowKeys: string[] }).__windowKeys)).not.toContain("Ctrl+n");

  // Modified variants are left alone (the composer's key isolation keeps them in the webview).
  await page.keyboard.press("Control+Shift+n");
  await page.keyboard.press("Alt+n");
  expect((await posted(page)).filter((m) => m.type === "newSession")).toHaveLength(1);

  // Same behaviour with Cmd on macOS.
  await host(page, { type: "init", strings: { ...STRINGS }, platform: "mac", folders: [{ uri: "file:///work", name: "work" }], activeFolder: "file:///work", issuesUrl: ISSUES_URL });
  await input.click();
  await page.evaluate(() => ((window as unknown as { __windowKeys: string[] }).__windowKeys.length = 0));
  await page.keyboard.press("Meta+n");
  expect((await posted(page)).filter((m) => m.type === "newSession")).toHaveLength(2);
  expect(await page.evaluate(() => (window as unknown as { __windowKeys: string[] }).__windowKeys)).not.toContain("Meta+n");
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

test("slash suggestions include commands, which stay as /command when sent", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "catalog",
    models: MODELS as never,
    agents: AGENTS as never,
    skills: [{ id: "mock-review", name: "Code review", description: "Review code changes." }],
    commands: [{ name: "mock-init", description: "Set up the project." }],
    selectedModel: { id: "hy4-flash-free", providerID: "opencode" },
    selectedAgent: "build",
  });
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("/");
  await expect(page.getByRole("option", { name: /mock-init/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Code review/ })).toBeVisible();
  await page.getByRole("option", { name: /mock-init/ }).click();
  await expect(input).toHaveValue("/mock-init ");
  await input.press("Enter");
  expect(await lastPosted(page, "send")).toMatchObject({ type: "send", text: "/mock-init", attachments: [] });
});

test("keyboard navigation keeps the active suggestion scrolled into view", async ({ page }) => {
  await boot(page);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${String(i).padStart(2, "0")}`, description: "A description long enough to fill the row." }));
  await host(page, {
    type: "catalog",
    models: MODELS as never,
    agents: AGENTS as never,
    skills: many,
    commands: [],
    selectedModel: { id: "hy4-flash-free", providerID: "opencode" },
    selectedAgent: "build",
  });
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("/");
  const popup = page.getByRole("listbox", { name: STRINGS.suggestions });
  await expect(popup).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await input.press("ArrowDown");
    const active = popup.locator('li[aria-selected="true"]');
    const popupBox = (await popup.boundingBox())!;
    const activeBox = (await active.boundingBox())!;
    expect(activeBox.y, `step ${i}`).toBeGreaterThanOrEqual(popupBox.y);
    expect(activeBox.y + activeBox.height, `step ${i}`).toBeLessThanOrEqual(popupBox.y + popupBox.height);
  }
  await expect(popup.locator('li[aria-selected="true"]')).toHaveAttribute("id", /^mention-2[0-9]$/);
});

test("build/plan mode picker defaults to build and switches agents", async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.build}` });
  await expect(trigger).toBeVisible();

  await trigger.click();
  const menu = page.getByRole("listbox", { name: STRINGS.mode });
  await expect(menu.getByRole("option", { name: /Build/ })).toHaveAttribute("aria-selected", "true");
  await menu.getByRole("option", { name: /Plan/ }).click();
  expect(await lastPosted(page, "setAgent")).toEqual({ type: "setAgent", agent: "plan" });
  await expect(menu).toHaveCount(0);
  // The host echoes the new selection; until then the trigger still shows Build.
  await expect(page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.build}` })).toBeVisible();

  await host(page, { type: "catalog", models: MODELS as never, agents: AGENTS as never, skills: [], selectedModel: { id: "hy4-flash-free", providerID: "opencode" }, selectedAgent: "plan" });
  await expect(page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.plan}` })).toBeVisible();

  await page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.plan}` }).click();
  await page.getByRole("listbox", { name: STRINGS.mode }).getByRole("option", { name: /Build/ }).click();
  expect(await lastPosted(page, "setAgent")).toEqual({ type: "setAgent", agent: "build" });
  await host(page, { type: "catalog", models: MODELS as never, agents: AGENTS as never, skills: [], selectedModel: { id: "hy4-flash-free", providerID: "opencode" }, selectedAgent: "build" });
  await expect(page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.build}` })).toBeVisible();

  // Servers without /api/agent have no agent picker, but the built-in mode picker must still work.
  await host(page, { type: "catalog", models: MODELS as never, agents: [] as never, skills: [], selectedModel: { id: "hy4-flash-free", providerID: "opencode" }, selectedAgent: "build" });
  await expect(page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.build}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `${STRINGS.agent}: Build` })).toHaveCount(0);
  await page.getByRole("button", { name: `${STRINGS.mode}: ${STRINGS.build}` }).click();
  await page.getByRole("listbox", { name: STRINGS.mode }).getByRole("option", { name: /Plan/ }).click();
  expect(await lastPosted(page, "setAgent")).toEqual({ type: "setAgent", agent: "plan" });
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
  // The confirmation names the session it is about to remove and defaults focus to Cancel.
  const confirm = dialog.getByRole("group", { name: `${STRINGS.confirmDelete}: Hello world reply` });
  await expect(confirm).toContainText("Hello world reply");
  await expect(dialog.getByRole("button", { name: STRINGS.cancel })).toBeFocused();
  await page.screenshot({ path: join(SHOTS, "15-session-delete-confirm-dark.png") });
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(await lastPosted(page, "deleteSession")).toBeUndefined();
  await dialog.getByRole("button", { name: `${STRINGS.deleteSession}: Hello world reply` }).click();
  await dialog.getByRole("button", { name: STRINGS.deleteSession, exact: true }).click();
  expect(await lastPosted(page, "deleteSession")).toEqual({ type: "deleteSession", id: S1 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("session list: busy and waiting-for-input sessions show distinct indicators", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "sessions",
    items: [
      { id: S1, title: "Hello world reply", updated: Date.now() - 120_000, busy: true, needsInput: false },
      { id: S2, title: "Idle chat", updated: Date.now() - 120_000, busy: false, needsInput: false },
    ],
  });
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.sessions}:`) }).click();
  const dialog = page.getByRole("dialog", { name: STRINGS.sessions });
  const busyItem = dialog.locator("li").filter({ hasText: "Hello world reply" });
  const idleItem = dialog.locator("li").filter({ hasText: "Idle chat" });
  await expect(busyItem.locator(".status-dot.session-busy.running")).toHaveCount(1);
  await expect(busyItem).toContainText(STRINGS.running);
  await expect(idleItem.locator(".status-dot.session-busy")).toHaveCount(0);

  await host(page, {
    type: "sessions",
    items: [
      { id: S1, title: "Hello world reply", updated: Date.now(), busy: true, needsInput: true },
      { id: S2, title: "Idle chat", updated: Date.now(), busy: false, needsInput: false },
    ],
  });
  await expect(busyItem.locator(".status-dot.session-busy.waiting")).toHaveCount(1);
  await expect(busyItem).toContainText(STRINGS.needsInput);
  await expect(idleItem.locator(".status-dot.session-busy")).toHaveCount(0);

  await host(page, { type: "sessions", items: [{ id: S1, title: "Hello world reply", updated: Date.now(), busy: false, needsInput: false }] });
  await expect(dialog.locator(".status-dot.session-busy")).toHaveCount(0);
});

test("session list: rename posts the new title", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.sessions}:`) }).click();
  const dialog = page.getByRole("dialog", { name: STRINGS.sessions });
  await dialog.getByRole("button", { name: `${STRINGS.renameSession}: Hello world reply` }).click();
  const card = dialog.getByRole("group", { name: STRINGS.renameSession });
  await expect(card.locator(".inline-question")).toHaveText(STRINGS.renameSession);
  const input = dialog.getByRole("textbox", { name: STRINGS.sessionTitle });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Hello world reply");
  await input.fill("Renamed chat");
  await input.press("Enter");
  expect(await lastPosted(page, "renameSession")).toEqual({ type: "renameSession", id: S1, title: "Renamed chat" });
  await expect(dialog.getByRole("textbox", { name: STRINGS.sessionTitle })).toHaveCount(0);
});

test("session list: outside clicks close it, inside clicks and the trigger do not", async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole("button", { name: new RegExp(`^${STRINGS.sessions}:`) });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: STRINGS.sessions });
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 4, y: 2 } });
  await expect(dialog).toBeVisible();
  await page.mouse.click(190, 400);
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(dialog).toBeVisible();
  await trigger.click();
  await expect(dialog).toHaveCount(0);
});

test("header marks the sessions trigger separately from the current chat", async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole("button", { name: `${STRINGS.sessions}: ${STRINGS.untitled}` });
  await expect(trigger.locator(".session-button-label")).toHaveText(STRINGS.sessions);
  await expect(trigger.locator(".session-current-dot")).toHaveCount(1);
  await expect(trigger.locator(".session-title")).toHaveText(STRINGS.untitled);
});

test("session list: load-more button follows the host's hasMore flag", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "sessions",
    items: [{ id: S1, title: "Hello world reply", updated: Date.now(), busy: false, needsInput: false }],
    hasMore: true,
  });
  await page.getByRole("button", { name: new RegExp(`^${STRINGS.sessions}:`) }).click();
  const dialog = page.getByRole("dialog", { name: STRINGS.sessions });
  const more = dialog.getByRole("button", { name: STRINGS.loadMoreSessions });
  await expect(more).toBeVisible();
  await more.click();
  expect(await lastPosted(page, "loadMoreSessions")).toEqual({ type: "loadMoreSessions" });
  await host(page, { type: "sessions", items: [], hasMore: false });
  await expect(dialog.getByRole("button", { name: STRINGS.loadMoreSessions })).toHaveCount(0);
});

test("the composer keeps a separate draft for each session", async ({ page }) => {
  await boot(page);
  await openSession(page, S1, []);
  // `host()` only posts the message; wait until the app has actually applied the session before typing.
  await expect(page.locator(".session-title")).toHaveText("Hello world reply");
  await page.waitForTimeout(100); // let the session-switch effect run before typing
  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await input.fill("draft for the first session");
  await expect(input).toHaveValue("draft for the first session");
  // Let the effect that feeds the debounce (and the 300ms debounce itself) settle before switching.
  await page.waitForTimeout(350);

  // Switching sessions stashes the first draft and shows the new session's empty draft.
  await openSession(page, S2, []);
  await expect(page.locator(".session-title")).toHaveText(STRINGS.untitled);
  await expect(input).toHaveValue("");

  // Coming back restores the first session's draft.
  await openSession(page, S1, []);
  await expect(page.locator(".session-title")).toHaveText("Hello world reply");
  await expect(input).toHaveValue("draft for the first session");
});

test("loading another session clears staged attachments and changes, a resync does not", async ({ page }) => {
  await boot(page);
  const attachment = { uri: "file:///work/a.ts", name: "a.ts", kind: "file" as const };
  const session = (id: string) => ({ type: "session" as const, session: { id, busy: false, messages: [], permissions: [], forms: [] } });
  await host(page, { type: "addAttachment", item: attachment });
  await host(page, { type: "changedFiles", files: [{ file: "src/a.txt", patch: "@@", additions: 1, deletions: 1, status: "modified" }] });
  await expect(page.locator(".chips li")).toHaveCount(3);
  await expect(page.locator(".panel.changes")).toBeVisible();

  await host(page, session(S2));
  await expect(page.locator(".chips li")).toHaveCount(2);
  await expect(page.locator(".panel.changes")).toHaveCount(0);

  await host(page, { type: "addAttachment", item: attachment });
  await host(page, session(S2)); // same-session resync
  await expect(page.locator(".chips li")).toHaveCount(3);
});

test("a sessionDelta appends the tail without clearing the conversation's UI state", async ({ page }) => {
  await boot(page);
  await host(page, { type: "session", session: { id: S1, busy: false, messages: [], permissions: [], forms: [] } });
  await expect(page.locator(".conversation")).toBeVisible();
  await host(page, { type: "addAttachment", item: { uri: "file:///work/a.ts", name: "a.ts", kind: "file" } });
  const chips = await page.locator(".chips li").count();

  await host(page, {
    type: "sessionDelta",
    delta: {
      sessionId: S1,
      messages: [{ id: "msg_tail", type: "user", text: "message from the resync tail", time: { created: 100 } }],
    },
  });
  await expect(page.locator(".conversation .msg.user .user-text")).toHaveText("message from the resync tail");
  await expect(page.locator(".chips li")).toHaveCount(chips);
});

test("the changed-files panel falls back to patches from tool metadata", async ({ page }) => {
  await boot(page);
  await host(page, {
    type: "session",
    session: {
      id: S1,
      busy: false,
      permissions: [],
      forms: [],
      messages: [
        {
          id: "msg_1",
          type: "assistant",
          agent: "build",
          model: { id: "hy4-flash-free", providerID: "opencode" },
          time: { created: 1, completed: 2 },
          content: [
            {
              type: "tool",
              id: "t1",
              name: "edit",
              state: {
                status: "completed",
                input: {},
                content: [],
                metadata: { files: [{ file: "src/tool.txt", patch: "@@ -1 +1 @@", additions: 2, deletions: 0, status: "modified" }] },
              },
            },
          ],
        },
      ],
    },
  });
  const panel = page.locator(".panel.changes");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".file-name")).toHaveText("src/tool.txt");
});

test("the changed-files refresh button has an instant tooltip and still refreshes", async ({ page }) => {
  await boot(page);
  await host(page, { type: "changedFiles", files: [{ file: "src/a.txt", patch: "@@", additions: 1, deletions: 1, status: "modified" }] });
  const button = page.locator(".panel.changes > summary .refresh-changes");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-label", STRINGS.refresh);

  const tip = () =>
    button.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return { content: s.content, visibility: s.visibility };
    });
  expect(await tip()).toMatchObject({ visibility: "hidden", content: `"${STRINGS.refresh}"` });
  await button.hover();
  expect(await tip()).toMatchObject({ visibility: "visible", content: `"${STRINGS.refresh}"` });

  await button.click();
  expect(await lastPosted(page, "refreshChanges")).toEqual({ type: "refreshChanges" });
});

test("the changed-files check button hides the panel until the changes change", async ({ page }) => {
  await boot(page);
  const file = (name: string) => ({ file: name, patch: "@@", additions: 1, deletions: 1, status: "modified" as const });
  await host(page, { type: "changedFiles", files: [file("src/a.txt")] });
  const panel = page.locator(".panel.changes");
  await expect(panel).toBeVisible();

  const check = page.locator(".panel.changes > summary .dismiss-changes");
  await expect(check).toHaveAttribute("aria-label", STRINGS.dismissChanges);
  await check.click();
  await expect(panel).toHaveCount(0);

  // A resync with the same files keeps it hidden.
  await host(page, { type: "changedFiles", files: [file("src/a.txt")] });
  await expect(panel).toHaveCount(0);

  // New changes bring it back.
  await host(page, { type: "changedFiles", files: [file("src/b.txt")] });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".file-name")).toHaveText("src/b.txt");
});

test("the changed-files refresh and check buttons sit together on the right", async ({ page }) => {
  await boot(page);
  await host(page, { type: "changedFiles", files: [{ file: "src/a.txt", patch: "@@", additions: 1, deletions: 1, status: "modified" }] });
  const summary = page.locator(".panel.changes > summary");
  const refresh = summary.locator(".refresh-changes");
  const check = summary.locator(".dismiss-changes");
  await expect(refresh).toBeVisible();
  await expect(check).toBeVisible();

  const s = (await summary.boundingBox())!;
  const r = (await refresh.boundingBox())!;
  const c = (await check.boundingBox())!;
  // The two buttons are adjacent, and the group is flush with the summary's right edge.
  expect(c.x - (r.x + r.width)).toBeLessThan(8);
  expect(s.x + s.width - (c.x + c.width)).toBeLessThan(8);
});

test("session cost from usage updates appears in the context meter tooltip", async ({ page }) => {
  await boot(page);
  await host(page, { type: "session", session: { id: S1, busy: false, messages: [], permissions: [], forms: [] } });
  const meter = page.locator(".context-meter");
  await expect(meter).toBeVisible();
  await expect.poll(async () => meter.getAttribute("data-tooltip")).not.toContain("$");
  await host(page, {
    type: "event",
    event: {
      type: "session.usage.updated",
      data: { sessionID: S1, cost: 0.1234, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    },
  });
  await expect.poll(async () => meter.getAttribute("data-tooltip")).toContain("$0.12");

  // A same-session reload (e.g. the post-turn resync) must not erase it.
  await host(page, {
    type: "session",
    session: {
      id: S1,
      busy: false,
      messages: [],
      permissions: [],
      forms: [],
      usage: { cost: 0.4321, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    },
  });
  await expect.poll(async () => meter.getAttribute("data-tooltip")).toContain("$0.43");
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

test("long chip tooltips do not create horizontal scroll", async ({ page }) => {
  await boot(page);
  // Long labels make chips wrap all the way to the right edge. Their hidden tooltips used to grow
  // rightwards past the viewport, leaving an empty horizontal scrollbar (issue reported on 0.3.8).
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `file:///work/src/a/very/long/path/to/component-${i}.tsx`,
    kind: "file",
    uri: `file:///work/src/a/very/long/path/to/component-${i}.tsx`,
    label: `component-with-a-very-long-name-${i}.tsx`,
    detail: "src/a/very/long/path",
  }));
  await host(page, { type: "context", items });
  await expect(page.locator(".chip")).toHaveCount(6);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  // The rightmost chip's tooltip must be anchored to the left, where there is room.
  const dirs = await page.locator(".chip .tooltip-host").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tipDir));
  expect(dirs).toContain("left");
});
