/* End-to-end test against a real `opencode serve` (OpenCode v2).
 * Skipped automatically when `opencode` is not installed or no model provider is configured.
 * Model selection: OC_E2E_MODEL="provider/model" or the first free OpenCode model.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenCodeClient } from "../../src/client/http";
import { EventStream } from "../../src/client/sse";
import { ManagedServer } from "../../src/server/server";
import type { ModelRef, ServerEvent } from "../../src/shared/api";
import { chatReducer, initialChatState, type ChatState, type UiAssistantMessage } from "../../src/shared/chatReducer";
import { applyPatch } from "../../src/shared/patch";

function hasOpencode(): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const available = hasOpencode();

describe.skipIf(!available)("real opencode serve", () => {
  let dir: string;
  let server: ManagedServer;
  let client: OpenCodeClient;
  let stream: EventStream;
  let model: ModelRef | undefined;
  const events: ServerEvent[] = [];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "oc-e2e-")));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "lines.txt"), "alpha\nbravo\ncharlie\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-qm", "init"], { cwd: dir });
    server = new ManagedServer({
      folder: dir,
      executable: "opencode",
      startupTimeoutMs: 30_000,
      autoRestart: false,
      log: () => {},
      recordsDir: mkdtempSync(join(tmpdir(), "oc-e2e-records-")),
    });
    const conn = await server.ensure();
    client = new OpenCodeClient(conn);
    stream = new EventStream({ url: client.eventUrl(), headers: client.headers(), onEvent: (e) => events.push(e) });
    stream.start();
    const models = await client.models();
    const wanted = process.env.OC_E2E_MODEL;
    const pick = wanted
      ? models.find((m) => `${m.providerID}/${m.id}` === wanted)
      : (models.find((m) => m.providerID === "opencode" && m.id === "hy4-flash-free") ??
        models.find((m) => m.providerID === "opencode" && /free/.test(m.id)));
    model = pick ? { id: pick.id, providerID: pick.providerID } : undefined;
  });

  afterAll(async () => {
    stream?.close();
    const pid = server?.pid;
    await server?.dispose();
    if (pid) expect(() => process.kill(pid, 0)).toThrow();
  });

  async function waitForEvent(sessionId: string, types: string[], from: number, timeoutMs = 120_000): Promise<ServerEvent> {
    const start = Date.now();
    for (;;) {
      const hit = events.slice(from).find((e) => types.includes(e.type) && (e.data as { sessionID?: string }).sessionID === sessionId);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${types.join("|")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function fold(sessionId: string, from: number): ChatState {
    const start = chatReducer(initialChatState, { type: "load", sessionId, messages: [], permissions: [], forms: [] });
    return chatReducer(start, { type: "events", events: events.slice(from) });
  }

  function text(state: ChatState): string {
    return state.messages
      .filter((m): m is UiAssistantMessage => m.kind === "assistant")
      .flatMap((m) => m.parts)
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("");
  }

  it("streams a reply and the live state matches the stored history", async (ctx) => {
    if (!model) ctx.skip();
    const session = await client.createSession({ directory: dir, agent: "build", model });
    const mark = events.length;
    await client.prompt(session.id, "Reply with exactly the single word: pong. Do not use any tools.");
    const end = await waitForEvent(session.id, ["session.execution.succeeded", "session.execution.failed"], mark);
    expect(end.type).toBe("session.execution.succeeded");
    expect(events.slice(mark).filter((e) => e.type === "session.text.delta").length).toBeGreaterThan(0);
    const live = fold(session.id, mark);
    expect(text(live).toLowerCase()).toContain("pong");
    expect(live.busy).toBe(false);

    const history = await client.messages(session.id);
    const restored = chatReducer(initialChatState, { type: "load", sessionId: session.id, messages: history, permissions: [], forms: [] });
    expect(text(restored)).toBe(text(live));
    expect(restored.messages.filter((m) => m.kind === "user").length).toBe(1);
  });

  it("accepts a line-range file attachment", async (ctx) => {
    if (!model) ctx.skip();
    const session = await client.createSession({ directory: dir, agent: "build", model });
    const mark = events.length;
    const uri = `${pathToFileURL(join(dir, "lines.txt")).toString()}?start=2&end=2`;
    await client.prompt(session.id, "Reply with only the word contained in the attached file excerpt. No tools.", [{ uri, name: "lines.txt" }]);
    const end = await waitForEvent(session.id, ["session.execution.succeeded", "session.execution.failed"], mark);
    expect(end.type).toBe("session.execution.succeeded");
    expect(text(fold(session.id, mark)).toLowerCase()).toContain("bravo");
    const history = await client.messages(session.id);
    const user = history.find((m) => m.type === "user");
    expect(user && user.type === "user" && user.files?.length).toBe(1);
  });

  it("waits for a permission reply, applies the edit and exposes a reversible diff", async (ctx) => {
    if (!model) ctx.skip();
    const session = await client.createSession({
      directory: dir,
      agent: "build",
      model,
      permissions: [{ action: "edit", resource: "*", effect: "ask" }],
    });
    const mark = events.length;
    await client.prompt(session.id, "Edit the file a.txt so that its only line is b instead of a. Use the edit tool. Do nothing else.");
    const asked = await waitForEvent(session.id, ["permission.asked"], mark);
    const req = asked.data as { id: string; action: string; metadata?: { files?: { patch: string }[] } };
    expect(req.action).toBe("edit");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
    const proposed = req.metadata?.files?.[0]?.patch;
    if (proposed) expect(applyPatch("a\n", proposed)).toBe("b\n");
    await client.replyPermission(session.id, req.id, "once");
    const end = await waitForEvent(session.id, ["session.execution.succeeded", "session.execution.failed"], mark);
    expect(end.type).toBe("session.execution.succeeded");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("b\n");
    const diff = await client.diff(session.id);
    const file = diff.find((d) => d.file === "a.txt");
    expect(file).toBeDefined();
    expect(applyPatch("b\n", file!.patch, { reverse: true })).toBe("a\n");
  });

  it("interrupts a long response", async (ctx) => {
    if (!model) ctx.skip();
    const session = await client.createSession({ directory: dir, agent: "build", model });
    const mark = events.length;
    await client.prompt(session.id, "Write a 1500 word essay about the history of the transistor. Do not use tools.");
    await waitForEvent(session.id, ["session.text.delta", "session.reasoning.delta"], mark);
    expect(await client.interrupt(session.id)).toBe(true);
    const end = await waitForEvent(session.id, ["session.execution.interrupted", "session.execution.succeeded"], mark, 30_000);
    expect(end.type).toBe("session.execution.interrupted");
    expect(fold(session.id, mark).busy).toBe(false);
  });

  it("lists sessions for the folder and deletes one", async () => {
    const session = await client.createSession({ directory: dir });
    expect((await client.listSessions(dir)).some((s) => s.id === session.id)).toBe(true);
    await client.deleteSession(session.id);
    expect((await client.listSessions(dir)).some((s) => s.id === session.id)).toBe(false);
  });
});
