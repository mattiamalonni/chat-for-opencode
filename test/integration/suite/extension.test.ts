import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatController } from "../../../src/chat/controller";
import type { HostMessage } from "../../../src/shared/protocol";
import { normalizeFsPath } from "./paths";

const workspace = process.env.OC_IT_WORKSPACE!;
let controller: ChatController;
const posted: HostMessage[] = [];

type ReconcileMessage = Extract<HostMessage, { type: "session" }> | Extract<HostMessage, { type: "sessionDelta" }>;

function busyOf(message: ReconcileMessage): boolean | undefined {
  return message.type === "session" ? message.session?.busy : message.delta.busy;
}

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
      "opencode.account",
      "opencode.showLogs",
      "opencode.setServerPassword",
      "opencode.stopServer",
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
    // The extension warms up the catalog with a throwaway session so `/` works before the first
    // prompt; that session must be deleted again, leaving no stray session in the list.
    assert.deepEqual(catalog.skills.map((s) => s.id), ["mock-review"]);
    assert.deepEqual(catalog.commands?.map((c) => c.name), ["mock-init"]);
    assert.deepEqual(catalog.selectedModel, { id: "mock-fast", providerID: "mock" });
    const sessions = await waitFor(() => lastPosted("sessions"), "sessions");
    assert.deepEqual(sessions.items, []);
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

  it("remembers a dismissed compatibility warning for that server version", async () => {
    const mark = posted.length;
    await controller.receive({ type: "dismissCompatibility", version: "2.2.7-mock" });
    await controller.receive({ type: "ready" });
    const conn = await waitFor(() => lastPosted("connection", mark), "connection");
    assert.equal(conn.compatibilityDismissed, true);
    const init = await waitFor(() => lastPosted("init", mark), "init");
    assert.equal(init.issuesUrl, "https://github.com/mattiamalonni/chat-for-opencode/issues");
  });

  it("sends a prompt and streams the reply", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "hello there", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded");
    assert.ok(eventPosted("session.text.delta", mark), "text deltas forwarded");
    assert.ok(controller.debugState.sessionId?.startsWith("ses_"));
    assert.equal(controller.debugState.storedSession, controller.debugState.sessionId);
    // Creating the session registers the plugin catalog: the webview must get a refreshed one.
    const refreshed = await waitFor(() => {
      const c = lastPosted("catalog", mark);
      return c && c.skills.some((s) => s.id === "mock-review") && c.commands?.some((x) => x.name === "mock-init") && c;
    }, "catalog refreshed after the session exists");
    assert.ok(refreshed);
    const sessions = await waitFor(() => {
      const s = lastPosted("sessions", mark);
      return s && s.items.some((i) => i.title === "hello there") && s;
    }, "session list with title");
    assert.equal(sessions.currentId, controller.debugState.sessionId);
  });

  it("manual sync reloads the session from the server and signals completion", async () => {
    const mark = posted.length;
    await controller.receive({ type: "sync" });
    const synced = await waitFor(() => lastPosted("synced", mark), "sync completion", 5000);
    assert.equal(synced.type, "synced");
    assert.ok(lastPosted("session", mark), "fresh history posted to the webview");
  });

  it("folds in a prompt written by another client without a manual sync", async () => {
    const sid = controller.debugState.sessionId;
    assert.ok(sid, "a session is open");
    const mark = posted.length;
    const res = await fetch(`${controller.debugState.baseUrl}/__mock/external`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID: sid, text: "from the tui" }),
    });
    assert.equal(res.status, 204);
    // Drive one poll explicitly: the 2s timer is timing-sensitive on slow CI runners. This still
    // exercises the exact host path used by the timer (history tail -> sessionDelta).
    await controller.pollNow();
    const delta = await waitFor(() => {
      const d = lastPosted("sessionDelta", mark);
      return d && d.delta.messages.some((m) => m.type === "user" && m.text === "from the tui") && d;
    }, "external prompt folded into the conversation", 12_000);
    assert.ok(delta);
  });

  it("asks for permission in the overlay and only proceeds after the reply, then lists changed files", async () => {
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

  it("rejecting a permission stops the turn and unlocks the composer", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[permission] reject this edit", attachments: [], context: [] });
    const asked = await waitFor(() => eventPosted("permission.asked", mark), "permission.asked");
    assert.ok(asked.type === "event");
    const data = asked.event.data as { id: string; sessionID: string };
    const beforeReject = posted.length;
    await controller.receive({ type: "permissionReply", sessionId: data.sessionID, requestId: data.id, decision: "reject" });
    const idle = await waitFor(
      () => posted.slice(beforeReject).find((m) => m.type === "event" && m.event.type === "session.status"),
      "local idle status after reject",
    );
    assert.ok(idle.type === "event");
    assert.equal((idle.event.data as { status: { type: string } }).status.type, "idle");
    await waitFor(() => eventPosted("session.execution.interrupted", mark), "execution interrupted");
  });

  it("auto-approves permission requests when the setting is enabled", async () => {
    const config = vscode.workspace.getConfiguration("opencode");
    const mark = posted.length;
    await config.update("autoApprovePermissions", true, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => lastPosted("autoApprove", mark)?.enabled === true, "setting reflected in the composer");
      await controller.receive({ type: "send", text: "[permission] unattended edit", attachments: [], context: [] });
      await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded without a reply");
      assert.equal(eventPosted("permission.asked", mark), undefined, "no inline card is shown");
    } finally {
      await config.update("autoApprovePermissions", false, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("remembers auto-approval per chat, overriding the global default", async () => {
    const sessionId = controller.debugState.sessionId!;
    const mark = posted.length;
    await controller.receive({ type: "setAutoApprove", enabled: true });
    await waitFor(() => lastPosted("autoApprove", mark)?.enabled === true, "auto-approve on for this chat");
    await controller.receive({ type: "send", text: "[permission] unattended per-chat edit", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded without a reply");
    assert.equal(eventPosted("permission.asked", mark), undefined, "no inline card is shown");

    // A new chat follows the global default (off)...
    await controller.receive({ type: "newSession" });
    await waitFor(() => lastPosted("autoApprove", mark)?.enabled === false, "off for a new chat");
    // ...while reopening the chat restores its own toggle.
    await controller.receive({ type: "selectSession", id: sessionId });
    await waitFor(() => lastPosted("autoApprove", mark)?.enabled === true, "remembered per chat");
    await controller.receive({ type: "setAutoApprove", enabled: false });
  });

  it("opens an applied change in the native diff editor with the reconstructed original", async () => {
    const patch = "Index: src/a.txt\n===================================================================\n--- src/a.txt\n+++ src/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    await controller.receive({ type: "openDiff", file: "src/a.txt", patch, applied: true });
    const tab = await waitFor(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff && t;
    }, "diff tab");
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(normalizeFsPath(input.modified.fsPath), normalizeFsPath(path.join(workspace, "src", "a.txt")));
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

  it("copies dropped files outside the workspace to disk, so the model gets their content", async () => {
    const mark = posted.length;
    const external = path.join(path.dirname(workspace), "oc-it-external.txt");
    writeFileSync(external, "outside the workspace");
    await controller.receive({
      type: "dropFiles",
      files: [
        { name: "app.ts", uri: vscode.Uri.file(path.join(workspace, "src", "app.ts")).toString() },
        { name: "external.txt", path: external },
        { name: "clip.txt", base64: Buffer.from("hello from drop").toString("base64"), mime: "text/plain" },
      ],
    });
    const adds = posted.slice(mark).filter((m) => m.type === "addAttachment");
    assert.equal(adds.length, 3);
    // Project files keep their path; content-only files get an on-disk copy the chip can open.
    assert.match(adds[0].item.uri, /^file:\/\//);
    assert.match(adds[1].item.uri, /^file:\/\//);
    assert.equal(readFileSync(vscode.Uri.parse(adds[1].item.uri).fsPath, "utf8"), "outside the workspace");
    assert.match(adds[2].item.uri, /^file:\/\//);
    assert.equal(readFileSync(vscode.Uri.parse(adds[2].item.uri).fsPath, "utf8"), "hello from drop");
  });

  it("opens a staged attachment's on-disk copy from the chip", async () => {
    const mark = posted.length;
    await controller.receive({
      type: "dropFiles",
      files: [{ name: "open-me.txt", base64: Buffer.from("open me").toString("base64"), mime: "text/plain" }],
    });
    const add = await waitFor(() => lastPosted("addAttachment", mark), "staged attachment");
    assert.match(add.item.uri, /^file:\/\//);

    await controller.receive({ type: "openAttachment", uri: add.item.uri });
    const file = vscode.Uri.parse(add.item.uri).fsPath;
    const editor = await waitFor(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file), "attachment editor");
    assert.equal(editor.document.getText(), "open me");
  });

  it("adds the current file outside the workspace as an openable copy", async () => {
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.addFileToChat", vscode.Uri.file(path.join(workspace, "src", "app.ts")));
    const inProject = await waitFor(() => lastPosted("addAttachment", mark), "addAttachment for a project file");
    assert.match(inProject.item.uri, /^file:\/\//);
    assert.equal(inProject.item.name, "app.ts");

    const external = path.join(path.dirname(workspace), "oc-it-current-file.txt");
    writeFileSync(external, "current file outside the workspace");
    const mark2 = posted.length;
    await vscode.commands.executeCommand("opencode.addFileToChat", vscode.Uri.file(external));
    const outside = await waitFor(() => lastPosted("addAttachment", mark2), "addAttachment for an external file");
    assert.match(outside.item.uri, /^file:\/\//);
    assert.equal(readFileSync(vscode.Uri.parse(outside.item.uri).fsPath, "utf8"), "current file outside the workspace");
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

  it("renames a session from the webview and updates the list and chat title", async () => {
    const id = controller.debugState.sessionId!;
    const mark = posted.length;
    await controller.receive({ type: "renameSession", id, title: "Integration renamed" });
    const sessions = await waitFor(() => {
      const s = lastPosted("sessions", mark);
      return s && s.items.some((i) => i.id === id && i.title === "Integration renamed") && s;
    }, "renamed session in the list");
    assert.equal(sessions.currentId, id);
    const renamed = await waitFor(
      () => posted.slice(mark).find((m) => m.type === "event" && m.event.type === "session.renamed"),
      "local session.renamed event",
    );
    assert.equal(renamed.type === "event" && (renamed.event.data as { title: string }).title, "Integration renamed");
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

  it("keeps the composer usable after an interrupt (reconcile must not re-lock busy)", async () => {
    const mark = posted.length;
    // `[stale-busy]` makes the mock leave time.busy newer than time.idle after the interrupt,
    // matching the observed real-server behaviour that used to lock the stop button.
    await controller.receive({ type: "send", text: "[slow][stale-busy] another long answer", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.text.delta", mark), "streaming started");
    await controller.receive({ type: "abort" });
    await waitFor(() => eventPosted("session.execution.interrupted", mark), "interrupted");

    // The post-turn reconcile re-fetches the session; its busy flag must stay false so the
    // send button doesn't get stuck on "stop". Only look at messages posted after the
    // terminal event, so this checks the reconcile and not the initial session load.
    const interruptIndex = posted.findIndex((m, i) => i >= mark && m.type === "event" && m.event.type === "session.execution.interrupted");
    const reconciled = await waitFor(
      () => posted.slice(interruptIndex + 1).find((m): m is ReconcileMessage => m.type === "session" || m.type === "sessionDelta"),
      "reconciled session",
    );
    assert.equal(busyOf(reconciled), false);

    // Interrupting an already-idle session emits no server event; the controller still posts
    // an idle status locally so the webview can never remain stuck on the stop button.
    const afterAbort = posted.length;
    await controller.receive({ type: "abort" });
    const idle = await waitFor(
      () => posted.slice(afterAbort).find((m) => m.type === "event" && m.event.type === "session.status"),
      "local idle status",
    );
    assert.equal(idle.type === "event" && (idle.event.data as { status: { type: string } }).status.type, "idle");
  });

  it("keeps the composer usable after cancelling a question", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[question] pick a color", attachments: [], context: [] });
    const created = await waitFor(() => eventPosted("form.created", mark), "question form");
    assert.ok(created.type === "event");
    const form = (created.event.data as { form: { id: string; sessionID: string } }).form;

    // Dismissing a form must unlock the composer even when the server sends no terminal
    // execution event, so only the local idle event proves that part of the fix.
    const beforeCancel = posted.length;
    await controller.receive({ type: "formCancel", sessionId: form.sessionID, formId: form.id });
    const idle = await waitFor(
      () => posted.slice(beforeCancel).find((m) => m.type === "event" && m.event.type === "session.status"),
      "local idle status after cancel",
    );
    assert.ok(idle.type === "event");
    const data = idle.event.data as { status: { type: string }; sessionID: string };
    assert.equal(data.status.type, "idle");
    assert.equal(data.sessionID, form.sessionID);
  });

  it("deletes every session in the folder with deleteAllSessions", async () => {
    // Start from a fresh session so the next prompt creates a new one to remove.
    await controller.receive({ type: "newSession" });
    const mark = posted.length;
    await controller.receive({ type: "send", text: "session for bulk delete", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "bulk-delete session finished");
    const before = await waitFor(() => {
      const s = lastPosted("sessions", mark);
      return s && s.items.length > 0 && s;
    }, "session list before delete all");
    assert.ok(before.items.length >= 1);
    assert.ok(controller.debugState.sessionId);

    const deleting = posted.length;
    // The webview message opens a native modal dialog, which cannot be clicked in tests; call the
    // deletion itself here (the webview test covers the message that leads to it).
    await controller.deleteAllSessions();

    const empty = await waitFor(() => {
      const s = lastPosted("sessions", deleting);
      return s && s.items.length === 0 && s;
    }, "empty session list after delete all");
    assert.deepEqual(empty.items, []);
    assert.equal(lastPosted("session", deleting)?.session, null);
    assert.equal(controller.debugState.sessionId, undefined);
    assert.equal(controller.debugState.storedSession, undefined);
  });

  it("does not re-lock the composer on the resync after cancelling a question", async () => {
    const mark = posted.length;
    // `[cancel-stale]` makes the mock finish with stale busy timestamps and no idle marker, so
    // the post-turn reconcile would otherwise bring the stop button back.
    await controller.receive({ type: "send", text: "[question][cancel-stale] pick a color", attachments: [], context: [] });
    const created = await waitFor(() => eventPosted("form.created", mark), "question form");
    assert.ok(created.type === "event");
    const form = (created.event.data as { form: { id: string; sessionID: string } }).form;
    await controller.receive({ type: "formCancel", sessionId: form.sessionID, formId: form.id });
    // Cancelling a question also interrupts the turn, so the terminal event is an interruption.
    await waitFor(() => eventPosted("session.execution.interrupted", mark), "execution interrupted");

    const terminalIndex = posted.findIndex((m, i) => i >= mark && m.type === "event" && m.event.type === "session.execution.interrupted");
    const reconciled = await waitFor(
      () => posted.slice(terminalIndex + 1).find((m): m is ReconcileMessage => m.type === "session" || m.type === "sessionDelta"),
      "reconciled session after cancel",
    );
    assert.equal(busyOf(reconciled), false);
  });

  it("rolls back to any turn with a staged revert and returns its prompt", async () => {
    await controller.receive({ type: "newSession" });
    const mark = posted.length;
    await controller.receive({ type: "send", text: "turn one", attachments: [], context: [] });
    await controller.receive({ type: "send", text: "turn two", attachments: [], context: [] });
    const withTwo = await waitFor<Extract<HostMessage, { type: "session" }>>(() => {
      const s = lastPosted("session", mark);
      return s?.session && s.session.messages.filter((m) => m.type === "user").length >= 2 ? s : undefined;
    }, "two turns in history");
    const firstUser = withTwo.session!.messages.find((m) => m.type === "user")!;
    const sid = controller.debugState.sessionId!;
    assert.ok(sid);

    // The native confirmation cannot be clicked in tests, so call the rollback itself (the webview
    // test covers the button and the message that leads here).
    const before = posted.length;
    await controller.revertToTurn(sid, firstUser.id, "turn one", true);
    await waitFor(() => lastPosted("reverted", before), "prompt returned to the composer");
    const reloaded = lastPosted("session", before);
    assert.ok(reloaded?.session, "history rebuilt after the commit");
    // Rolling back to the first turn drops that prompt and every later message.
    assert.equal(reloaded.session!.messages.length, 0);
    const reverted = lastPosted("reverted", before)!;
    assert.equal(reverted.sessionId, sid);
    assert.equal(reverted.text, "turn one");
  });

  it("rediscovers a running subagent and its pending permission after a session switch", async () => {
    const baseUrl = controller.debugState.baseUrl;
    assert.ok(baseUrl, "server is running");
    const previous = controller.debugState.sessionId;
    const create = async (parentID?: string): Promise<string> => {
      const res = await fetch(`${baseUrl}/__mock/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: controller.debugState.folder ?? workspace, ...(parentID ? { parentID } : {}) }),
      });
      assert.equal(res.status, 200);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };

    const parent = await create();
    const child = await create(parent);
    // A running `subagent` tool persists with `metadata: {}` — OpenCode writes the child id only
    // on success. Discovery must therefore come from the child's `parentID` in the session list.
    const seed = await fetch(`${baseUrl}/__mock/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: parent,
        messages: [
          { type: "user", id: "msg_seed_user", text: "use a subagent", time: { created: 1 } },
          {
            type: "assistant",
            id: "msg_seed_assistant",
            agent: "build",
            model: { id: "mock-fast", providerID: "mock" },
            time: { created: 2 },
            content: [
              {
                type: "tool",
                id: "tool_seed_subagent",
                name: "subagent",
                state: { status: "running", input: { description: "child with permission" }, metadata: {}, content: [] },
              },
            ],
          },
        ],
      }),
    });
    assert.equal(seed.status, 204);
    const ask = await fetch(`${baseUrl}/__mock/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID: child, action: "edit", resources: [".env"] }),
    });
    assert.equal(ask.status, 204);

    const mark = posted.length;
    await controller.receive({ type: "selectSession", id: parent });
    const session = await waitFor(() => lastPosted("session", mark), "session post for the switched chat", 10_000);
    assert.equal(session.session?.id, parent);
    const snapshot = await waitFor(
      () => posted.slice(mark).find((m): m is Extract<HostMessage, { type: "subagent" }> => m.type === "subagent" && m.snapshot.sessionId === child),
      "running subagent rediscovered from the session list",
      10_000,
    );
    assert.ok(snapshot.snapshot.permissions.some((p) => p.action === "edit"), "child's pending permission restored");
    // The webview clears child state on a session switch, so the snapshot must come afterwards.
    const sessionIndex = posted.findIndex((m, i) => i >= mark && m.type === "session" && m.session?.id === parent);
    const snapshotIndex = posted.indexOf(snapshot);
    assert.ok(sessionIndex >= 0 && snapshotIndex > sessionIndex, "session posted before child snapshots");

    if (previous) {
      await controller.receive({ type: "selectSession", id: previous });
      await waitFor(() => lastPosted("session", mark + 1)?.session?.id === previous, "original session restored");
    }
  });

  it("stops the server cleanly and reconnects on the next prompt", async () => {
    const oldUrl = controller.debugState.baseUrl;
    const mark = posted.length;
    await vscode.commands.executeCommand("opencode.stopServer");
    await waitFor(() => controller.debugState.status === "idle" && !controller.debugState.baseUrl, "stopped");
    assert.notEqual(lastPosted("connection", mark)?.status, "reconnecting");
    const afterStop = posted.length;
    await controller.receive({ type: "send", text: "after stop", attachments: [], context: [] });
    await waitFor(() => controller.debugState.status === "connected" && controller.debugState.baseUrl !== oldUrl, "reconnected on send");
    await waitFor(() => eventPosted("session.execution.succeeded", afterStop), "prompt after the stop succeeded");
  });
});
