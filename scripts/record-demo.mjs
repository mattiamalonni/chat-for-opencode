/**
 * Records the README hero GIF (docs/images/demo.gif): the real chat webview, driven through the
 * UI-test harness with event shapes taken from a recorded OpenCode stream, next to a mock editor.
 *
 *   npm run demo:record   (builds dist/webview.js first)
 *
 * Frames are captured at scripted moments (not on a timer), so every run produces the same GIF.
 * Each frame after the first stores only the pixels that changed; the rest are transparent, which
 * keeps a mostly static UI recording small.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs", "images", "demo.gif");
const WIDTH = 1000;
const HEIGHT = 640;

// Node 24 strips the types of the shared string table, so the demo shows the shipped English UI text.
const strings = await import(pathToFileURL(join(root, "src", "shared", "strings.ts")).href);

// ---- the editor file --------------------------------------------------------------------------

const before = [
  `<span class="k">export</span> <span class="k">interface</span> <span class="t">Item</span> { <span class="v">name</span>: <span class="t">string</span>; <span class="v">price</span>: <span class="t">number</span>; <span class="v">qty</span>: <span class="t">number</span> }`,
  ``,
  `<span class="k">export</span> <span class="k">function</span> <span class="f">total</span>(<span class="v">items</span>: <span class="t">Item</span>[]): <span class="t">number</span> {`,
  `  <span class="k">let</span> <span class="v">sum</span> = <span class="n">0</span>;`,
  `  <span class="c">for</span> (<span class="k">let</span> <span class="v">i</span> = <span class="n">1</span>; <span class="v">i</span> &lt; <span class="v">items</span>.<span class="v">length</span>; <span class="v">i</span>++) {`,
  `    <span class="v">sum</span> += <span class="v">items</span>[<span class="v">i</span>].<span class="v">price</span> * <span class="v">items</span>[<span class="v">i</span>].<span class="v">qty</span>;`,
  `  }`,
  `  <span class="c">return</span> <span class="t">Math</span>.<span class="f">round</span>(<span class="v">sum</span> * <span class="n">100</span>) / <span class="n">100</span>;`,
  `}`,
  ``,
  `<span class="k">export</span> <span class="k">const</span> <span class="v">FREE_SHIPPING</span> = <span class="n">50</span>;`,
];
const fixedLine = `  <span class="c">for</span> (<span class="k">let</span> <span class="v">i</span> = <span class="n">0</span>; <span class="v">i</span> &lt; <span class="v">items</span>.<span class="v">length</span>; <span class="v">i</span>++) {`;
const SELECTED = new Set([3, 4, 5, 6, 7, 8, 9]);

function codeHtml(lines, { selected = new Set(), changed = new Set() } = {}) {
  return lines
    .map((l, i) => {
      const n = i + 1;
      const cls = ["line", selected.has(n) ? "sel" : "", changed.has(n) ? "changed" : ""].filter(Boolean).join(" ");
      return `<div class="${cls}"><span class="ln">${n}</span>${l || " "}</div>`;
    })
    .join("");
}

// ---- the conversation -------------------------------------------------------------------------

const SID = "ses_demo";
const DIR = "/work/shop";
const MODEL = { id: "hy4-flash-free", providerID: "opencode", variant: "default" };
const PROMPT = "Why does total() undercount the cart? Fix it.";
const PATCH =
  "Index: src/cart.ts\n===================================================================\n--- src/cart.ts\n+++ src/cart.ts\n@@ -4,4 +4,4 @@\n   let sum = 0;\n-  for (let i = 1; i < items.length; i++) {\n+  for (let i = 0; i < items.length; i++) {\n     sum += items[i].price * items[i].qty;\n   }\n";
const FILES = [{ file: "src/cart.ts", patch: PATCH, status: "modified", additions: 1, deletions: 1 }];
let clock = 1_800_000_000_000;
const ev = (type, data) => ({ type, created: (clock += 120), data: { sessionID: SID, ...data } });
const words = (text, n = 3) => text.match(new RegExp(`(\\S+\\s*){1,${n}}`, "g")) ?? [text];

// ---- recording --------------------------------------------------------------------------------

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(root, "scripts", "demo", "stage.html")).href);
const chat = page.frame({ url: /harness\.html/ });
if (!chat) throw new Error("chat frame not found");
await chat.waitForFunction(() => window.__posted?.some((m) => m.type === "ready"));

const host = (msg) => chat.evaluate((m) => window.postMessage(m, "*"), msg);
const setCode = (opts) => page.evaluate((html) => (document.getElementById("code").innerHTML = html), codeHtml(opts.lines, opts));
const frames = [];
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function shot(delay) {
  await settle();
  frames.push({ png: await page.screenshot(), delay });
}

async function moveCursor(x, y, steps = 8, delay = 40) {
  const from = await page.evaluate(() => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(document.getElementById("cursor").style.transform);
    return m ? [Number(m[1]), Number(m[2])] : [700, 560];
  });
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.evaluate(
      ([cx, cy]) => (document.getElementById("cursor").style.transform = `translate(${cx}px, ${cy}px)`),
      [from[0] + (x - from[0]) * e, from[1] + (y - from[1]) * e],
    );
    await shot(delay);
  }
}

async function ripple(x, y) {
  await page.evaluate(
    ([cx, cy]) => {
      const r = document.getElementById("ripple");
      Object.assign(r.style, { left: `${cx}px`, top: `${cy}px`, opacity: "1", transform: "scale(0.6)" });
    },
    [x, y],
  );
  await shot(90);
  await page.evaluate(() => Object.assign(document.getElementById("ripple").style, { transform: "scale(1.2)", opacity: "0.4" }));
  await shot(90);
  await page.evaluate(() => (document.getElementById("ripple").style.opacity = "0"));
}

/** Centre of a chat element in stage coordinates. */
async function chatPoint(selector) {
  const box = await chat.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function stream(events, delay = 110) {
  for (const e of events) {
    await host({ type: "event", event: e });
    await shot(delay);
  }
}

// Boot the chat like the extension host does.
await setCode({ lines: before, selected: SELECTED });
await host({
  type: "init",
  strings: strings.STRINGS,
  platform: "mac",
  folders: [{ uri: `file://${DIR}`, name: "shop" }],
  activeFolder: `file://${DIR}`,
});
await host({ type: "connection", status: "connected" });
await host({
  type: "catalog",
  models: [
    {
      id: MODEL.id,
      modelID: MODEL.id,
      providerID: MODEL.providerID,
      name: "Hy4 flash Free",
      enabled: true,
      variants: [],
      limit: { context: 1_048_576, output: 65_536 },
    },
  ],
  agents: [],
  skills: [],
  selectedModel: { id: MODEL.id, providerID: MODEL.providerID },
  selectedAgent: "build",
});
await host({ type: "sessions", items: [] });
await host({ type: "session", session: null });
await host({
  type: "context",
  items: [
    { id: "f", kind: "file", uri: `file://${DIR}/src/cart.ts`, label: "cart.ts", detail: "src/cart.ts" },
    { id: "s", kind: "selection", uri: `file://${DIR}/src/cart.ts?start=3&end=9`, label: "cart.ts:3-9", detail: "src/cart.ts" },
  ],
});
await shot(1600);

// Click into the composer and type the question.
const [cx, cy] = await chatPoint("textarea");
await moveCursor(cx - 60, cy, 10, 35);
await ripple(cx - 60, cy);
await chat.locator("textarea").first().click();
for (let i = 2; i <= PROMPT.length; i += 2) {
  await chat.locator("textarea").first().fill(PROMPT.slice(0, i));
  await shot(55);
}
await chat.locator("textarea").first().fill(PROMPT);
await shot(500);
await moveCursor(700, 600, 6, 30);
await chat.locator("textarea").first().press("Enter");

// The host opens a session and the stream starts.
await host({ type: "session", session: { id: SID, busy: true, messages: [], permissions: [], forms: [] } });
const m1 = "msg_demo_1";
const m2 = "msg_demo_2";
const m3 = "msg_demo_3";
await stream([
  ev("session.inbox.enqueued", { inboxID: "in_1", item: { type: "user", payload: { text: PROMPT }, delivery: "steer" } }),
  ev("session.execution.started", {}),
  ev("session.inbox.delivered", { inboxID: "in_1" }),
  ev("session.step.started", { agent: "build", model: MODEL, assistantMessageID: m1 }),
  ev("session.reasoning.started", { assistantMessageID: m1, ordinal: 0 }),
]);
const thought = "The total skips something. Let me read the loop in src/cart.ts.";
for (const d of words(thought)) await stream([ev("session.reasoning.delta", { assistantMessageID: m1, ordinal: 0, delta: d })], 90);
const t1 = "tool_read";
await stream([
  ev("session.tool.input.started", { assistantMessageID: m1, id: t1, name: "read" }),
  ev("session.reasoning.ended", { assistantMessageID: m1, ordinal: 0, text: thought }),
  ev("session.tool.input.ended", { assistantMessageID: m1, id: t1, text: '{"path": "src/cart.ts"}' }),
  ev("session.tool.called", { assistantMessageID: m1, id: t1, input: { path: "src/cart.ts" }, executed: false }),
  ev("session.tool.success", {
    assistantMessageID: m1,
    id: t1,
    content: [{ type: "text", text: "Read file src/cart.ts, lines 1-11" }],
    metadata: { truncated: false },
    executed: false,
  }),
  ev("session.step.ended", {
    assistantMessageID: m1,
    finish: "tool-calls",
    rawFinish: "tool_calls",
    tokens: { input: 6420, output: 38, reasoning: 31, cache: { read: 1792, write: 0 } },
    cost: 0,
  }),
  ev("session.renamed", { title: "Fix total() skipping the first item" }),
  ev("session.step.started", { agent: "build", model: MODEL, assistantMessageID: m2 }),
  ev("session.text.started", { assistantMessageID: m2, ordinal: 0 }),
]);
const explain =
  "The loop starts at `i = 1`, so the **first item is never added** to the sum. A one-item cart totals `0`. Starting the loop at `0` fixes it:";
for (const d of words(explain)) await stream([ev("session.text.delta", { assistantMessageID: m2, ordinal: 0, delta: d })], 80);
const t2 = "tool_edit";
const editInput = { path: "src/cart.ts", oldString: "let i = 1;", newString: "let i = 0;" };
await stream([
  ev("session.text.ended", { assistantMessageID: m2, ordinal: 0, text: explain }),
  ev("session.tool.input.started", { assistantMessageID: m2, id: t2, name: "edit" }),
  ev("session.tool.input.ended", { assistantMessageID: m2, id: t2, text: JSON.stringify(editInput) }),
  ev("session.tool.called", { assistantMessageID: m2, id: t2, input: editInput, executed: false }),
  ev("session.step.streamed", { assistantMessageID: m2 }),
]);
await host({
  type: "event",
  event: ev("permission.asked", {
    id: "per_demo",
    action: "edit",
    resources: ["src/cart.ts"],
    save: ["*"],
    metadata: { files: FILES },
    source: { type: "tool", messageID: m2, id: t2 },
  }),
});
await shot(1400);

// Approve the edit.
const [ax, ay] = await chatPoint(".card.permission button.primary");
await moveCursor(ax, ay, 12, 35);
await shot(350);
await ripple(ax, ay);
await chat.locator(".card.permission button.primary").first().click();
await stream([
  ev("permission.replied", { requestID: "per_demo", reply: "once" }),
  ev("session.tool.success", {
    assistantMessageID: m2,
    id: t2,
    content: [{ type: "text", text: "Edited src/cart.ts (1 replacement)" }],
    metadata: { files: FILES, truncated: false },
    executed: false,
  }),
]);
const fixed = [...before];
fixed[4] = fixedLine;
await page.evaluate(() => document.getElementById("tab").classList.add("modified"));
await setCode({ lines: fixed, changed: new Set([5]) });
// Park the cursor over empty editor space while the answer finishes.
await moveCursor(470, 430, 8, 30);
await stream([
  ev("session.step.ended", {
    assistantMessageID: m2,
    finish: "tool-calls",
    rawFinish: "tool_calls",
    tokens: { input: 312, output: 61, reasoning: 0, cache: { read: 8192, write: 0 } },
    cost: 0,
    files: ["src/cart.ts"],
  }),
  ev("session.step.started", { agent: "build", model: MODEL, assistantMessageID: m3 }),
  ev("session.text.started", { assistantMessageID: m3, ordinal: 0 }),
]);
const done = "Done — `total()` now counts every item, so a one-item cart returns its price instead of `0`.";
for (const d of words(done)) await stream([ev("session.text.delta", { assistantMessageID: m3, ordinal: 0, delta: d })], 80);
await stream([
  ev("session.text.ended", { assistantMessageID: m3, ordinal: 0, text: done }),
  ev("session.step.ended", {
    assistantMessageID: m3,
    finish: "stop",
    rawFinish: "stop",
    tokens: { input: 98, output: 27, reasoning: 0, cache: { read: 8448, write: 0 } },
    cost: 0,
  }),
  ev("session.usage.updated", { cost: 0, tokens: { input: 6830, output: 126, reasoning: 31, cache: { read: 18432, write: 0 } } }),
  ev("session.execution.succeeded", {}),
]);
await shot(3800);
await browser.close();

// ---- encoding ---------------------------------------------------------------------------------

/** Merge consecutive identical frames into one longer frame. */
const merged = [];
for (const f of frames) {
  const prev = merged.at(-1);
  if (prev && prev.png.equals(f.png)) prev.delay += f.delay;
  else merged.push({ ...f });
}

// DEMO_FRAMES=<dir> also writes every merged frame as a PNG, to review the storyboard.
if (process.env.DEMO_FRAMES) {
  mkdirSync(process.env.DEMO_FRAMES, { recursive: true });
  merged.forEach((f, i) => writeFileSync(join(process.env.DEMO_FRAMES, `${String(i).padStart(3, "0")}.png`), f.png));
}

const gif = GIFEncoder();
let previous;
for (const [index, f] of merged.entries()) {
  const { data, width, height } = PNG.sync.read(f.png);
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const palette = quantize(rgba, 255);
  const pixels = applyPalette(rgba, palette);
  const transparentIndex = palette.length;
  if (previous) {
    // Unchanged pixels become transparent and the previous frame shows through (dispose: 1).
    for (let p = 0; p < pixels.length; p++) {
      const o = p * 4;
      if (rgba[o] === previous[o] && rgba[o + 1] === previous[o + 1] && rgba[o + 2] === previous[o + 2]) pixels[p] = transparentIndex;
    }
  }
  gif.writeFrame(pixels, width, height, {
    palette: [...palette, [255, 0, 255]],
    delay: Math.max(20, Math.round(f.delay / 10) * 10),
    transparent: index > 0,
    transparentIndex,
    dispose: 1,
    repeat: 0,
  });
  previous = rgba;
}
gif.finish();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, gif.bytes());
const seconds = merged.reduce((s, f) => s + f.delay, 0) / 1000;
console.log(`${OUT}: ${merged.length} frames, ${seconds.toFixed(1)} s, ${(gif.bytes().length / 1024 / 1024).toFixed(2)} MB`);
