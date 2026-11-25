import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ChatController } from "../../../src/chat/controller";
import type { HostMessage } from "../../../src/shared/protocol";

/** Same mock API as the other integration suite, but reached through the embedded-host path. */
const workspace = process.env.OC_IT_WORKSPACE!;
const mockUrl = process.env.OC_IT_MOCK_URL!;
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
  return posted
    .slice(since)
    .filter((m): m is Extract<HostMessage, { type: K }> => m.type === type)
    .at(-1);
}

function eventPosted(type: string, since: number) {
  return posted.slice(since).find((m) => m.type === "event" && m.event.type === type);
}

describe("chat-for-opencode — embedded SDK path", () => {
  before(async () => {
    assert.ok(mockUrl, "mock endpoint passed to the extension host");
    const ext = vscode.extensions.getExtension("mattiamalonni.chat-for-opencode");
    assert.ok(ext, "extension found");
    controller = ((await ext.activate()) as { controller: ChatController }).controller;
    controller.onDidPost((m) => posted.push(m));
    // The workspace starts on `opencode.endpoint`; clearing it forces ServerRegistry to take the
    // ManagedServer (embedded SDK) branch. The injected bridge still talks to the mock API.
    await vscode.workspace
      .getConfiguration("opencode", vscode.Uri.file(workspace))
      .update("endpoint", "", vscode.ConfigurationTarget.Workspace);
    await controller.resetServers();
  });

  it("creates the embedded host and loads the catalog", async () => {
    await vscode.commands.executeCommand("opencode.chatView.focus");
    await waitFor(() => controller.debugState.status === "connected", "connected through embedded host");
    assert.equal(controller.debugState.baseUrl, "in-process");
    const catalog = await waitFor(() => lastPosted("catalog"), "catalog");
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ["mock-fast", "mock-smart"],
    );
    assert.deepEqual(
      catalog.agents.map((a) => a.id),
      ["build", "plan"],
    );
    assert.deepEqual(
      catalog.skills.map((s) => s.id),
      ["mock-review"],
    );
  });

  it("streams a prompt through the SDK event subscription", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "from the embedded host", attachments: [], context: [] });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded");
    assert.ok(eventPosted("session.text.delta", mark), "text deltas forwarded from SDK events");
  });

  it("forwards permissions raised inside the embedded host", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[permission] change a.txt", attachments: [], context: [] });
    const asked = await waitFor(() => eventPosted("permission.asked", mark), "permission.asked");
    assert.ok(asked.type === "event");
    const data = asked.event.data as { id: string; sessionID: string };
    await controller.receive({ type: "permissionReply", sessionId: data.sessionID, requestId: data.id, decision: "once" });
    await waitFor(() => eventPosted("session.execution.succeeded", mark), "execution succeeded after approval");
  });

  it("resyncs after the event subscription ends", async () => {
    const mark = posted.length;
    await controller.receive({ type: "send", text: "[crash]", attachments: [], context: [] });
    await waitFor(() => posted.slice(mark).some((m) => m.type === "connection" && m.status === "reconnecting"), "reconnecting status");
    await waitFor(() => controller.debugState.status === "connected", "connected again");
  });
});
