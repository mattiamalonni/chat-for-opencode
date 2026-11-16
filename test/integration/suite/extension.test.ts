import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatController } from "../../../src/chat/controller";
import type { HostMessage } from "../../../src/shared/protocol";

const workspace = process.env.OC_IT_WORKSPACE!;
let controller: ChatController;
const posted: HostMessage[] = [];

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lastPosted<K extends HostMessage["type"]>(type: K, since = 0): Extract<HostMessage, { type: K }> | undefined {
  return posted.slice(since).filter((m): m is Extract<HostMessage, { type: K }> => m.type === type).at(-1);
}

function eventPosted(type: string, since: number) {
  return posted.slice(since).find((m) => m.type === "event" && m.event.type === type);
}

describe("chat-for-opencode extension", () => {
  before(async () => {
    const ext = vscode.extensions.getExtension("mattiamalonni.chat-for-opencode");
    assert.ok(ext, "extension found");
    const api = (await ext.activate()) as { controller: ChatController };
    controller = api.controller;
    controller.onDidPost((m) => posted.push(m));
  });

  it("activates on startup and reveals the chat on first run", async () => {
    await waitFor(() => controller.isVisible, "chat revealed without user action", 15_000);
  });

  it("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of [
      "opencode.newSession",
      "opencode.reconnect",
      "opencode.addSelectionToChat",
      "opencode.addFileToChat",
      "opencode.focus",
      "opencode.showLogs",
      "opencode.setServerPassword",
      "opencode.stopServer",
      "opencode.showChanges",
      "opencode.moveView",
    ]) {
      assert.ok(all.includes(c), `missing command ${c}`);
    }
  });

  it("opens the sidebar, starts the managed server and loads the catalog", async () => {
    await vscode.commands.executeCommand("opencode.focus");
    await waitFor(() => controller.debugState.status === "connected", "connected");
    assert.match(controller.debugState.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const catalog = await waitFor(() => lastPosted("catalog"), "catalog");
    assert.deepEqual(catalog.models.map((m) => m.id), ["mock-fast", "mock-smart"]);
    assert.deepEqual(catalog.agents.map((a) => a.id), ["build", "plan"]);
    assert.deepEqual(catalog.selectedModel, { id: "mock-fast", providerID: "mock" });
  });

  it("lives in the secondary side bar (right) on VS Code >= 1.104", async function () {
    const [major, minor] = vscode.version.split(".").map(Number);
    if (major === 1 && minor < 104) this.skip();
    await vscode.commands.executeCommand("opencode.focus");
    await waitFor(() => controller.isVisible, "view visible");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await waitFor(() => !controller.isVisible, "hidden with the secondary side bar", 5000);
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
    await waitFor(() => controller.isVisible, "visible again with the secondary side bar", 5000);
  });

  it("sends a prompt and streams the reply", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "hello there", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded");
    assert.ok(eventPosted("session.text.delta", mark), "text deltas forwarded");
    assert.ok(controller.debugState.sessionId?.startsWith("ses_"));
    assert.equal(controller.debugState.storedSession, controller.debugState.sessionId);
    const sessions = await waitFor(() => {
      const s = lastPosted("sessions", mark);
      return s && s.items.some((i) => i.title === "hello there") && s;
    }, "session list with title");
    assert.equal(sessions.currentId, controller.debugState.sessionId);
  });

  it("asks for permission inline and only proceeds after the reply, then lists changed files", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[permission] change a.txt", attachments: [], context: [] });
    const asked = await waitFor(() => eventPosted("permission.asked", mark), "permission.asked");
    assert.ok(asked.type === "event");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(eventPosted("session.execution.succeeded", mark), undefined, "must wait for the user");
    const data = asked.event.data as { id: string; sessionID: string };
    await controller.receive({ type: "permissionReply", sessionId: data.sessionID, requestId: data.id, decision: "once" });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded");
    const changed = await waitFor(() => {
      const c = lastPosted("changedFiles", mark);
      return c && c.files.length > 0 && c;
    }, "changed files");
    assert.equal(changed.files[0].file, "src/a.txt");
  });

  it("opens an applied change in the native diff editor with the reconstructed original", async () => {
    const patch = "Index: src/a.txt\n===================================================================\n--- src/a.txt\n+++ src/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    await controller.receive({ type: "openDiff", file: "src/a.txt", patch, applied: true });
    const tab = await waitFor(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff && t;
    }, "diff tab");
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.modified.fsPath, path.join(workspace, "src", "a.txt"));
    const original = await vscode.workspace.openTextDocument(input.original);
    assert.equal(original.getText(), "a\n");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("adds the editor selection to the chat from the command", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(workspace, "src", "app.ts"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 1, 5);
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.addSelectionToChat");
    const add = await waitFor(() => lastPosted("addAttachment", mark), "addAttachment");
    assert.match(add.item.uri, /app\.ts\?start=1&end=2$/);
    assert.equal(add.item.kind, "selection");
    const ctx = await waitFor(() => {
      const c = lastPosted("context", mark);
      return c && c.items.length === 2 && c;
    }, "context with file + selection");
    assert.deepEqual(ctx.items.map((i) => i.kind), ["file", "selection"]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("searches workspace files for @ mentions", async () => {
    const mark = posted.length;
    await controller.receive({ type: "searchFiles", query: "app" });
    const res = await waitFor(() => lastPosted("fileResults", mark), "fileResults");
    assert.equal(res.items[0]?.detail, "src/app.ts");
  });

  it("starts a new session and switches back to the previous one", async () => {
    const previous = controller.debugState.sessionId!;
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.newSession");
    assert.equal(controller.debugState.sessionId, undefined);
    assert.equal(controller.debugState.storedSession, undefined);
    assert.ok(posted.slice(mark).some((m) => m.type === "session" && m.session === null));
    await controller.receive({ type: "selectSession", id: previous });
    const s = await waitFor(() => lastPosted("session", mark), "session loaded");
    assert.equal(s.session?.id, previous);
    assert.ok((s.session?.messages.length ?? 0) >= 4);
  });

  it("resumes the stored session after the server restarts", async () => {
    const id = controller.debugState.sessionId!;
    const oldUrl = controller.debugState.baseUrl;
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.reconnect");
    await waitFor(() => controller.debugState.status === "connected" && controller.debugState.baseUrl !== oldUrl, "reconnected");
    const s = await waitFor(() => lastPosted("session", mark), "session reloaded");
    assert.equal(s.session?.id, id);
    assert.ok(s.session!.messages.some((m) => m.type === "user" && m.text === "hello there"));
  });

  it("restarts the server automatically after a crash", async () => {
    const oldUrl = controller.debugState.baseUrl;
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[crash]", attachments: [], context: [] });
    await waitFor(() => posted.slice(mark).some((m) => m.type === "connection" && m.status === "reconnecting"), "reconnecting status");
    await waitFor(() => controller.debugState.status === "connected" && controller.debugState.baseUrl !== oldUrl, "auto-restarted", 30_000);
  });

  it("interrupts a running response", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[slow] long answer", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.text.delta", mark), "streaming started");
    await controller.receive({ type: "abort" });
    await waitFor(() => eventPosted("session.execution.interrupted", mark), "interrupted");
  });
});
