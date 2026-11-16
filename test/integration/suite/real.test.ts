// Opt-in (OC_IT_REAL=1): the extension inside real VS Code, driving a real `opencode serve`.
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatController } from "../../../src/chat/controller";
import type { HostMessage } from "../../../src/shared/protocol";

const workspace = process.env.OC_IT_WORKSPACE!;
let controller: ChatController;
const posted: HostMessage[] = [];

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 120_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ev = (type: string, since: number) => posted.slice(since).find((m) => m.type === "event" && m.event.type === type);
const done = (since: number) =>
  posted.slice(since).find((m) => m.type === "event" && /^session\.execution\.(succeeded|failed|interrupted)$/.test(m.event.type));

describe("real opencode serve inside VS Code", () => {
  before(async () => {
    const ext = vscode.extensions.getExtension("mattiamalonni.opencode-chat")!;
    controller = ((await ext.activate()) as { controller: ChatController }).controller;
    controller.onDidPost((m) => posted.push(m));
    await vscode.commands.executeCommand("opencode.focus");
    await waitFor(() => controller.debugState.status === "connected", "connected", 60_000);
  });

  it("streams a reply", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "Reply with exactly the single word: pong. No tools.", attachments: [], context: [] });
    const end = await waitFor(() => done(mark), "execution end");
    assert.ok(end.type === "event" && end.event.type === "session.execution.succeeded", JSON.stringify(end));
    assert.ok(ev("session.text.delta", mark), "streamed deltas");
  });

  it("asks permission, applies after approval and opens the diff", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "Edit a.txt so its only line is b instead of a. Use the edit tool. Nothing else.", attachments: [], context: [] });
    const asked = await waitFor(() => ev("permission.asked", mark), "permission.asked");
    const data = (asked as Extract<HostMessage, { type: "event" }>).event.data as { id: string; sessionID: string };
    await controller.receive({ type: "permissionReply", sessionId: data.sessionID, requestId: data.id, decision: "once" });
    await waitFor(() => done(mark), "execution end");
    const changed = await waitFor(() => {
      const c = posted.slice(mark).filter((m): m is Extract<HostMessage, { type: "changedFiles" }> => m.type === "changedFiles").at(-1);
      return c && c.files.find((f) => f.file === "a.txt");
    }, "changed a.txt");
    await controller.receive({ type: "openDiff", file: changed.file, patch: changed.patch, applied: true });
    const tab = await waitFor(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff && t;
    }, "diff tab", 10_000);
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.modified.fsPath, path.join(workspace, "a.txt"));
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), "a\n");
  });

  it("resumes the session after the server restarts", async () => {
    const id = controller.debugState.sessionId;
    assert.equal(controller.debugState.storedSession, id);
    const oldUrl = controller.debugState.baseUrl;
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.reconnect");
    await waitFor(() => controller.debugState.status === "connected" && controller.debugState.baseUrl !== oldUrl, "reconnected", 60_000);
    const s = await waitFor(() => posted.slice(mark).filter((m): m is Extract<HostMessage, { type: "session" }> => m.type === "session").at(-1), "session");
    assert.equal(s.session?.id, id);
    assert.ok(s.session!.messages.filter((m) => m.type === "user").length >= 2);
  });
});
