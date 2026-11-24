import * as assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatController, ExecutionState } from "../../../src/chat/controller";
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
  return posted
    .slice(since)
    .filter((m): m is Extract<HostMessage, { type: K }> => m.type === type)
    .at(-1);
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
      "opencode.restart",
      "opencode.openSettings",
      "opencode.openChatInEditor",
      "opencode.account",
      "opencode.connect",
      "opencode.showLogs",
      "opencode.setServerPassword",
      "opencode.stopServer",
      "opencode.moveView",
      "opencode.install",
    ]) {
      assert.ok(all.includes(c), `missing command ${c}`);
    }
  });

  it("opens the sidebar, starts the managed server and loads the catalog", async () => {
    await vscode.commands.executeCommand("opencode.chatView.focus");
    await waitFor(() => controller.debugState.status === "connected", "connected");
    assert.match(controller.debugState.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const catalog = await waitFor(() => lastPosted("catalog"), "catalog");
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ["mock-fast", "mock-smart"],
    );
    assert.deepEqual(
      catalog.agents.map((a) => a.id),
      ["build", "plan"],
    );
    // The extension warms up the catalog with a throwaway session so `/` works before the first
    // prompt; that session must be deleted again, leaving no stray session in the list.
    assert.deepEqual(
      catalog.skills.map((s) => s.id),
      ["mock-review"],
    );
    assert.deepEqual(
      catalog.commands?.map((c) => c.name),
      ["mock-init"],
    );
    assert.deepEqual(catalog.selectedModel, { id: "mock-fast", providerID: "mock" });
    const sessions = await waitFor(() => lastPosted("sessions"), "sessions");
    assert.deepEqual(sessions.items, []);
  });

  it("keeps the connected server when the Connect panel loads", async () => {
    await waitFor(() => controller.debugState.status === "connected", "connected before Connect panel");
    const mark = posted.length;
    const baseUrl = controller.debugState.baseUrl;
    await vscode.commands.executeCommand("opencode.connect");
    // Give the panel's `ready` handler time to load integrations before checking the chat state.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(controller.debugState.status, "connected", "the panel must not restart/reconnect the server");
    assert.equal(controller.debugState.baseUrl, baseUrl);
    assert.ok(
      !posted.slice(mark).some((m) => m.type === "connection" && m.status === "starting"),
      "no 'Starting OpenCode…' status from the Connect panel",
    );
  });

  it("lives in the secondary side bar (right) on VS Code >= 1.104", async function () {
    const [major, minor] = vscode.version.split(".").map(Number);
    if (major === 1 && minor < 104) this.skip();
    await vscode.commands.executeCommand("opencode.chatView.focus");
    await waitFor(() => controller.isVisible, "view visible");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await waitFor(() => !controller.isVisible, "hidden with the secondary side bar", 5000);
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
    await waitFor(() => controller.isVisible, "visible again with the secondary side bar", 5000);
  });

  it("remembers a dismissed compatibility warning for that server version", async () => {
    const mark = posted.length;
    await controller.receive({ type: "dismissCompatibility", version: "2.4.0-mock" });
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
    await waitFor(() => controller.debugState.status === "connected", "connected before external sync", 5000);
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
    // Any delta since the mark counts, not just the newest one: a reconnect resync can post an
    // empty delta afterwards and hide the update that actually folded the external prompt in.
    const delta = await waitFor(
      () =>
        posted
          .slice(mark)
          .find(
            (m): m is Extract<HostMessage, { type: "sessionDelta" }> =>
              m.type === "sessionDelta" && m.delta.messages.some((x) => x.type === "user" && x.text === "from the tui"),
          ),
      "external prompt folded into the conversation",
      12_000,
    );
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
    const patch =
      "Index: src/a.txt\n===================================================================\n--- src/a.txt\n+++ src/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
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

  it("opens a project file attachment from a sent prompt, jumping to the selected line", async () => {
    const file = path.join(workspace, "src", "app.ts");
    const uri = `${vscode.Uri.file(file).toString()}?start=2&end=2`;
    await controller.receive({ type: "openAttachment", uri });
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => normalizeFsPath(e.document.uri.fsPath) === normalizeFsPath(file)),
      "project attachment editor",
    );
    assert.equal(editor.document.getText(), "export const one = 1;\nexport const two = 2;\n");
    assert.equal(editor.selection.start.line, 1);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("refuses to open an attachment outside the workspace and the temp directory", async () => {
    const external = path.join(path.dirname(workspace), "oc-it-blocked.txt");
    writeFileSync(external, "not allowed");
    await controller.receive({ type: "openAttachment", uri: vscode.Uri.file(external).toString() });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === external),
      false,
    );
  });

  it("opens a clicked tool file outside the workspace", async () => {
    const external = path.join(path.dirname(workspace), "oc-it-tool-file.txt");
    writeFileSync(external, "outside but explicit");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await controller.receive({ type: "openToolFile", path: external });
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => normalizeFsPath(e.document.uri.fsPath) === normalizeFsPath(external)),
      "outside tool file editor",
    );
    assert.equal(editor.document.getText(), "outside but explicit");
  });

  it("does not follow a symlink that escapes the workspace", async function () {
    if (process.platform === "win32") this.skip(); // symlink creation needs elevated privileges there
    const external = path.join(path.dirname(workspace), "oc-it-secret.txt");
    writeFileSync(external, "secret outside the workspace");
    const link = path.join(workspace, "oc-it-escape.txt");
    symlinkSync(external, link);
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await controller.receive({ type: "openFile", path: "oc-it-escape.txt" });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        vscode.window.visibleTextEditors.some((e) => normalizeFsPath(e.document.uri.fsPath) === normalizeFsPath(external)),
        false,
        "openFile must resolve the link before opening",
      );
      await controller.receive({ type: "openAttachment", uri: vscode.Uri.file(link).toString() });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        vscode.window.visibleTextEditors.some((e) => normalizeFsPath(e.document.uri.fsPath) === normalizeFsPath(external)),
        false,
        "openAttachment must resolve the link before opening",
      );
    } finally {
      unlinkSync(link);
    }
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
    // The toolbar Restart command asks for confirmation (a native modal); call the underlying
    // controller action directly, which is exactly what the confirmed command does.
    await controller.resetServers();
    await waitFor(() => controller.debugState.status === "connected" && controller.debugState.baseUrl !== oldUrl, "reconnected");
    const s = await waitFor(() => lastPosted("session", mark), "session reloaded");
    assert.equal(s.session?.id, id);
    assert.ok(s.session!.messages.some((m) => m.type === "user" && m.text === "hello there"));
  });

  it("still sends the prompt when the first history fetch fails", async () => {
    // A transient 500 on the history endpoint used to reject loadSession() before `prompt()`,
    // silently swallowing the user's message. The fetch now degrades to an empty history.
    // Placed after the "resumes the stored session" test so it does not change that session.
    await controller.receive({ type: "newSession" });
    const baseUrl = controller.debugState.baseUrl!;
    const armed = await fetch(`${baseUrl}/__mock/failHistoryOnce`, { method: "POST" });
    assert.equal(armed.status, 204);
    const mark = posted.length;
    await controller.receive({ type: "send", text: "after history failure", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded despite history failure");
    assert.ok(eventPosted("session.text.delta", mark), "reply streamed after history failure");
    assert.ok(controller.debugState.sessionId?.startsWith("ses_"), "a session was created");
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

  it("keeps the composer usable when the interrupt request itself fails", async () => {
    // The server applies the interrupt but responds with a 500. Without the local-idle guard in a
    // `finally`, the rejected request used to leave the composer locked on "stop" indefinitely.
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[slow] answer with failing interrupt", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.text.delta", mark), "streaming started");
    const armed = await fetch(`${controller.debugState.baseUrl}/__mock/failInterruptOnce`, { method: "POST" });
    assert.equal(armed.status, 204);

    await controller.receive({ type: "abort" });
    const idle = await waitFor(
      () => posted.slice(mark).find((m) => m.type === "event" && m.event.type === "session.status"),
      "local idle status after failed interrupt",
    );
    assert.equal(idle.type === "event" && (idle.event.data as { status: { type: string } }).status.type, "idle");
    assert.ok(lastPosted("notice", mark), "the failed request is still reported to the user");
  });

  it("restores a refused prompt, closes the running state and resends it from the Retry action", async () => {
    await controller.receive({ type: "newSession" });
    const mark = posted.length;
    const armed = await fetch(`${controller.debugState.baseUrl}/__mock/failPromptOnce`, { method: "POST" });
    assert.equal(armed.status, 204);

    // The status bar listens to this event; the spinner must not survive a refused prompt.
    const states: ExecutionState[] = [];
    const subscription = controller.onDidChangeExecution((state) => states.push(state));
    try {
      await controller.receive({ type: "send", text: "do not lose me", attachments: [], context: [] });
      const notice = await waitFor(() => lastPosted("notice", mark), "prompt failed notice");
      assert.equal(notice.error.kind, "promptFailed");
      assert.ok(notice.error.actions.includes("retry"));
      const restored = await waitFor(() => lastPosted("draftRestored", mark), "restored draft");
      assert.equal(restored.text, "do not lose me");
      assert.equal(restored.force, undefined);
      assert.ok(
        states.some((s) => s.status === "running"),
        "the optimistic running state was published",
      );
      assert.equal(states.at(-1)?.status, "failed", "execution state is terminal, not stuck on running");

      await controller.receive({ type: "action", id: "retry" });
      await waitFor(() => eventPosted("session.text.delta", mark), "reply streamed after retry");
    } finally {
      subscription.dispose();
    }
    const cleared = await waitFor(
      () =>
        posted
          .slice(mark)
          .find((m): m is Extract<HostMessage, { type: "draftRestored" }> => m.type === "draftRestored" && m.force === true),
      "composer cleared after retry",
    );
    assert.equal(cleared.text, "");
  });

  it("drops malformed webview messages before they can reach privileged dispatch", async () => {
    const mark = posted.length;
    const sessionBefore = controller.debugState.sessionId;
    // Neither a bogus action id nor malformed nested data may be dispatched on the host side.
    await controller.receive({ type: "action", id: "deleteAllSessions" } as never);
    await controller.receive({ type: "openFile", path: 42 } as never);
    await controller.receive({ type: "send", text: "x", attachments: [{} as never], context: [] });
    await controller.receive({ type: "notAProtocolMessage" } as never);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(controller.debugState.sessionId, sessionBefore);
    // Live events from the preceding turn may still be in flight; only the actions that invalid
    // input could have triggered are checked here.
    const sideEffects = posted.slice(mark).filter((m) => m.type === "notice" || m.type === "draftRestored");
    assert.deepEqual(sideEffects, [], "invalid input produced no host-side effects");
  });

  it("reports a transient catalog failure as a request error and recovers automatically", async () => {
    const mark = posted.length;
    const armed = await fetch(`${controller.debugState.baseUrl}/__mock/failModelsOnce`, { method: "POST" });
    assert.equal(armed.status, 204);

    await controller.receive({ type: "ready" });
    const failed = await waitFor(
      () =>
        posted.slice(mark).find((m): m is Extract<HostMessage, { type: "connection" }> => m.type === "connection" && m.status === "error"),
      "catalog request error",
    );
    assert.equal(failed.error?.kind, "requestFailed");
    assert.ok(failed.error?.actions.includes("reconnect"));
    assert.ok(!failed.error?.actions.includes("login"), "a failed request is not a missing provider");

    const from = posted.indexOf(failed) + 1;
    await waitFor(
      () =>
        posted
          .slice(from)
          .find((m): m is Extract<HostMessage, { type: "connection" }> => m.type === "connection" && m.status === "connected"),
      "automatic catalog retry",
    );
  });

  it("restores the previous model when the server refuses a switch", async () => {
    const before = lastPosted("catalog")?.selectedModel?.id ?? "mock-fast";
    const mark = posted.length;
    const armed = await fetch(`${controller.debugState.baseUrl}/__mock/failSwitchOnce`, { method: "POST" });
    assert.equal(armed.status, 204);

    await controller.receive({ type: "setModel", model: { id: "mock-smart", providerID: "mock" } });
    const notice = await waitFor(() => lastPosted("notice", mark), "switch failure notice");
    assert.equal(notice.error.kind, "requestFailed");
    const after = await waitFor(() => lastPosted("catalog", mark), "catalog after the failed switch");
    assert.equal(after.selectedModel?.id, before);
  });

  it("ignores a late state notification from a server that is no longer attached", async () => {
    // A folder switch detaches the previous server; a queued "running" notification from it must not
    // rebind the chat to its endpoint (the old check compared only client URLs, not server identity).
    const baseUrl = controller.debugState.baseUrl!;
    const mark = posted.length;
    const hook = controller as unknown as { onServerState(state: unknown, server?: unknown): void };
    hook.onServerState(
      { status: "running", conn: { baseUrl: "http://127.0.0.1:1", password: "stale" }, version: "2.4.0" },
      { folder: "detached" },
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(controller.debugState.baseUrl, baseUrl);
    assert.ok(!posted.slice(mark).some((m) => m.type === "connection" && m.status === "error"));
  });

  it("stops the external live poll when starting a new session", async () => {
    await waitFor(() => controller.debugState.livePolling || undefined, "live poll running");
    await controller.receive({ type: "newSession" });
    assert.equal(controller.debugState.livePolling, false);

    const mark = posted.length;
    await controller.receive({ type: "send", text: "restart the poll", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "reply after new session");
    await waitFor(() => controller.debugState.livePolling || undefined, "live poll restarted");
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

  it("does not re-lock the composer on a resync after a local idle", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[question][cancel-stale] pick a color", attachments: [], context: [] });
    const created = await waitFor(() => eventPosted("form.created", mark), "question form");
    assert.ok(created.type === "event");
    const form = (created.event.data as { form: { id: string; sessionID: string } }).form;
    await controller.receive({ type: "formCancel", sessionId: form.sessionID, formId: form.id });
    await waitFor(() => eventPosted("session.execution.interrupted", mark), "execution interrupted");

    // A reconnect-style resync reads the stale busy timestamp from the server. The locally posted
    // idle must keep the composer unlocked there too, not just in the post-turn reconcile (which
    // uses a different generation counter). Drive `resync()` directly: toggling the auxiliary bar
    // is not portable (the chat lives in the Explorer on VS Code < 1.104) and disturbs later tests.
    const beforeResync = posted.length;
    await controller.resyncNow();
    const resynced = await waitFor(
      () => posted.slice(beforeResync).find((m): m is ReconcileMessage => m.type === "session" || m.type === "sessionDelta"),
      "resynced session after local idle",
    );
    assert.equal(busyOf(resynced), false);
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

  it("forks a turn into a new session and keeps the original conversation", async () => {
    await controller.receive({ type: "newSession" });
    const mark = posted.length;
    await controller.receive({ type: "send", text: "fork me", attachments: [], context: [] });
    const withTurn = await waitFor(() => {
      const p = lastPosted("session", mark);
      return p?.session?.messages.some((m) => m.type === "user") ? p : undefined;
    }, "a turn to fork");
    const sid = controller.debugState.sessionId!;
    const userId = withTurn.session!.messages.find((m) => m.type === "user")!.id;

    await controller.receive({ type: "forkTo", sessionId: sid, messageID: userId });
    const forked = await waitFor(() => lastPosted("forked", mark), "forked notice");
    assert.notEqual(forked.sessionId, sid);
    assert.equal(controller.debugState.sessionId, forked.sessionId);
    const loaded = lastPosted("session", mark);
    assert.equal(loaded?.session?.id, forked.sessionId);
    // Forking before the first prompt yields an empty branch; the source keeps its history.
    assert.equal(loaded!.session!.messages.length, 0);
    const sessions = await waitFor(() => {
      const s = lastPosted("sessions", mark);
      return s?.items.some((i) => i.id === sid) ? s : undefined;
    }, "original session still listed");
    assert.ok(
      sessions.items.some((i) => i.id === forked.sessionId),
      "fork listed too",
    );
  });

  it("publishes the server inbox and applies promote/cancel from the webview", async () => {
    const baseUrl = controller.debugState.baseUrl;
    const sid = controller.debugState.sessionId;
    assert.ok(baseUrl && sid, "connected with an open session");
    const item = {
      id: "msg_queued_it",
      sessionID: sid,
      time: { created: 1 },
      type: "user",
      delivery: "queue",
      payload: { text: "queued in integration" },
    };
    await fetch(`${baseUrl}/__mock/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID: sid, items: [item] }),
    });

    const mark = posted.length;
    await controller.receive({ type: "sync" });
    const inbox = await waitFor(() => lastPosted("inbox", mark), "inbox after sync");
    assert.deepEqual(
      inbox.items.map((i) => i.id),
      [item.id],
    );

    await controller.receive({ type: "setInboxDelivery", sessionId: sid, inboxId: item.id, delivery: "steer" });
    const promoted = await waitFor(() => {
      const i = lastPosted("inbox", mark);
      return i?.items[0]?.delivery === "steer" ? i : undefined;
    }, "promoted to steer");
    assert.equal(promoted.items[0].payload.text, "queued in integration");

    await controller.receive({ type: "cancelInbox", sessionId: sid, inboxId: item.id });
    await waitFor(() => {
      const i = lastPosted("inbox", mark);
      return i && i.items.length === 0 ? i : undefined;
    }, "inbox emptied after cancel");
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
      () =>
        posted
          .slice(mark)
          .find((m): m is Extract<HostMessage, { type: "subagent" }> => m.type === "subagent" && m.snapshot.sessionId === child),
      "running subagent rediscovered from the session list",
      10_000,
    );
    assert.ok(
      snapshot.snapshot.permissions.some((p) => p.action === "edit"),
      "child's pending permission restored",
    );
    // The webview clears child state on a session switch, so the snapshot must come afterwards.
    const sessionIndex = posted.findIndex((m, i) => i >= mark && m.type === "session" && m.session?.id === parent);
    const snapshotIndex = posted.indexOf(snapshot);
    assert.ok(sessionIndex >= 0 && snapshotIndex > sessionIndex, "session posted before child snapshots");

    if (previous) {
      await controller.receive({ type: "selectSession", id: previous });
      await waitFor(() => lastPosted("session", mark + 1)?.session?.id === previous, "original session restored");
    }
  });

  it("closes a running turn when the open session changes", async () => {
    const states: ExecutionState[] = [];
    const subscription = controller.onDidChangeExecution((state) => states.push(state));
    try {
      await controller.receive({ type: "send", text: "[slow] switch away", attachments: [], context: [] });
      await waitFor(() => states.at(-1)?.status === "running", "running state before the switch");
      await controller.receive({ type: "newSession" });
      await waitFor(() => states.at(-1)?.status === "idle", "idle state after the switch");
      assert.equal(states.at(-1)?.sessionId, undefined);
    } finally {
      subscription.dispose();
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

  // The tests above are stateful (session/turn state), so the new-feature checks come last.
  it("opens all changed files in VS Code's native multi-file diff", async () => {
    const patch = (file: string, before: string, after: string) =>
      `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n@@ -1,1 +1,1 @@\n-${before}\n+${after}\n`;
    await controller.receive({
      type: "openDiffs",
      files: [
        { file: "src/a.txt", patch: patch("src/a.txt", "a", "b") },
        { file: "src/app.ts", patch: patch("src/app.ts", "export const zero = 1;", "export const one = 1;") },
      ],
    });
    const tab = await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab, "multi-file diff tab");
    // `TabInputTextMultiDiff` is not in the 1.99 typings yet, so check the shape at runtime.
    const input = tab.input as { textDiffs?: Array<{ original: vscode.Uri; modified: vscode.Uri }> };
    assert.equal(input.textDiffs?.length, 2, "two real files in one multi-diff editor");
    assert.equal(normalizeFsPath(input.textDiffs![0].modified.fsPath), normalizeFsPath(path.join(workspace, "src", "a.txt")));
    assert.equal(normalizeFsPath(input.textDiffs![1].modified.fsPath), normalizeFsPath(path.join(workspace, "src", "app.ts")));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("publishes needsInput while a permission is pending, then returns to running", async () => {
    const states: ExecutionState[] = [];
    const subscription = controller.onDidChangeExecution((state) => states.push(state));
    try {
      const mark = posted.length;
      await controller.receive({ type: "send", text: "[permission] status bar state", attachments: [], context: [] });
      const asked = await waitFor(() => eventPosted("permission.asked", mark), "permission.asked");
      assert.ok(asked.type === "event");
      await waitFor(() => (states.some((s) => s.status === "needsInput") ? true : undefined), "needsInput state");
      const data = asked.event.data as { id: string; sessionID: string };
      await controller.receive({ type: "permissionReply", sessionId: data.sessionID, requestId: data.id, decision: "once" });
      await waitFor(() => (states.some((s) => s.status === "running") ? true : undefined), "running after the reply");
      await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded");
    } finally {
      subscription.dispose();
    }
  });

  it("publishes the prompt library and prefills a prompt with the active file", async () => {
    const document = await vscode.workspace.openTextDocument(path.join(workspace, "src", "app.ts"));
    await vscode.window.showTextDocument(document);
    const catalog = await waitFor(
      () => posted.find((m): m is Extract<HostMessage, { type: "promptCatalog" }> => m.type === "promptCatalog"),
      "prompt catalog",
    );
    assert.ok(catalog.items.some((p) => p.id === "explain"));

    const mark = posted.length;
    await controller.receive({ type: "usePrompt", id: "explain" });
    const prefill = await waitFor(() => lastPosted("prefillDraft", mark), "prefilled prompt from the library");
    assert.match(prefill.text, /Explain/);
    assert.match(prefill.text, /src[\\/]app\.ts/);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("publishes session usage that feeds the status bar meter", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[usage] status bar", attachments: [], context: [] });
    await waitFor(
      () =>
        posted.slice(mark).some((m) => (m.type === "session" ? m.session?.usage : m.type === "sessionDelta" ? m.delta.usage : false))
          ? true
          : undefined,
      "session usage in a posted payload",
    );
  });
});
