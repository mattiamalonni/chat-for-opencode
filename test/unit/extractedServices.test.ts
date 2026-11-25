import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  env: { openExternal: vi.fn(async () => true) },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  },
  window: {
    showInformationMessage: vi.fn(async () => undefined),
    showTextDocument: vi.fn(async () => ({ revealRange: vi.fn() })),
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  Uri: {
    parse: (value: string) => ({ fsPath: value, toString: () => value, with: () => ({ fsPath: value }) }),
    file: (value: string) => ({ fsPath: value, toString: () => value, with: () => ({ fsPath: value }) }),
    joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: parts.join("/"), toString: () => parts.join("/") }),
  },
  Position: class {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Selection: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  TextEditorRevealType: { InCenter: 1 },
}));

import { createControllerState } from "../../src/chat/services/controllerState";
import { ChatDraftActions } from "../../src/chat/services/draftActions";
import { ChatFileActions } from "../../src/chat/services/fileActions";
import { ChatPermissionActions } from "../../src/chat/services/permissionActions";
import { ChatRefreshActions } from "../../src/chat/services/refreshActions";
import { ChatServerActions } from "../../src/chat/services/serverActions";

describe("extracted controller services", () => {
  it("createControllerState starts from an idle, empty snapshot", () => {
    const state = createControllerState();
    expect(state).toMatchObject({
      status: "idle",
      sessionId: undefined,
      folder: undefined,
      catalogRetries: 0,
      lastSessionEventAt: 0,
    });
    expect(state.contract.failures).toEqual([]);
  });

  it("ChatDraftActions posts and persists drafts by session", async () => {
    const posted: unknown[] = [];
    const updates: unknown[] = [];
    let saved: { drafts?: Record<string, string>; globalDraft?: string } = { drafts: { s1: "old" }, globalDraft: "g" };
    const folder = { uri: { toString: () => "file:///w" } };
    const actions = new ChatDraftActions({
      state: { ...createControllerState(), folder: folder as never },
      workspaceState: {
        get: vi.fn(() => saved),
        update: vi.fn(async (_key: string, value: unknown) => {
          saved = value as typeof saved;
          updates.push(value);
        }),
        keys: vi.fn(),
      } as never,
      post: (msg) => posted.push(msg),
    });
    actions.post();
    expect(posted).toEqual([{ type: "drafts", drafts: { s1: "old" }, globalDraft: "g" }]);
    await actions.save("s1", "new");
    expect(updates).toEqual([{ drafts: { s1: "new" }, globalDraft: "g" }]);
    await actions.save(undefined, "global");
    expect(updates.at(-1)).toEqual({ drafts: { s1: "new" }, globalDraft: "global" });
  });

  it("ChatFileActions posts attachments and notices and opens external links", async () => {
    const posted: unknown[] = [];
    const warnings: string[] = [];
    const actions = new ChatFileActions({
      state: createControllerState(),
      attachments: { dropFiles: vi.fn(async () => {}), pickFiles: vi.fn(async () => {}), open: vi.fn(async () => {}) } as never,
      post: (msg) => posted.push(msg),
      logWarn: (line) => warnings.push(line),
      isWithinWorkspace: vi.fn(async () => true),
    });
    const item = { uri: "file:///a", name: "a" };
    actions.addAttachment(item as never);
    actions.noticeTooLarge("big");
    actions.noticeUnreadable("bad", "oops");
    expect(posted).toHaveLength(3);
    expect(warnings[0]).toContain("skipped unreadable attachment bad");
    await actions.dropFiles([]);
    await actions.pickFiles();
    await actions.openAttachment("file:///a");
    await actions.openLink("https://example.com");
    expect(vi.mocked((await import("vscode")).env.openExternal)).toHaveBeenCalled();
  });

  it("ChatFileActions opens a clicked tool file even outside the workspace", async () => {
    const warnings: string[] = [];
    const actions = new ChatFileActions({
      state: { ...createControllerState(), folder: { uri: { fsPath: "/w" } } as never },
      attachments: { dropFiles: vi.fn(async () => {}), pickFiles: vi.fn(async () => {}), open: vi.fn(async () => {}) } as never,
      post: () => {},
      logWarn: (line) => warnings.push(line),
      isWithinWorkspace: vi.fn(async () => false),
    });
    await actions.openToolFile("/outside/a.txt");
    const vscode = await import("vscode");
    expect(vi.mocked(vscode.workspace.openTextDocument)).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/outside/a.txt" }));
    expect(vi.mocked(vscode.window.showTextDocument)).toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("ChatPermissionActions reads, posts and grants permissions", async () => {
    const posted: unknown[] = [];
    const events: Array<{ sid: string; event: unknown }> = [];
    const permissions = {
      enabled: vi.fn(() => true),
      write: vi.fn(async () => {}),
      setPending: vi.fn(),
      approveOnce: vi.fn(async () => false),
    };
    const actions = new ChatPermissionActions({
      state: createControllerState(),
      permissions: permissions as never,
      subagents: { ids: () => [] } as never,
      getClient: () => undefined,
      getDirectory: () => undefined,
      post: (msg) => posted.push(msg),
      postSessionEvent: (sid, event) => events.push({ sid, event }),
      postExternal: (event, sid) => events.push({ sid, event }),
      forgetExternalRequest: () => {},
      log: () => {},
    });
    expect(actions.enabled()).toBe(true);
    actions.post();
    expect(posted).toEqual([{ type: "autoApprove", enabled: true }]);
    await actions.set(false);
    expect(permissions.write).toHaveBeenCalledWith(false);
    await actions.autoApprove({ type: "permission.asked", data: { id: "p1" } } as never, "s1");
    expect(events).toHaveLength(1);
    await actions.approvePending();
    expect(events).toHaveLength(1);
  });

  it("ChatRefreshActions hides the fork notice that OpenCode leaves in the fork's inbox", () => {
    const posted: unknown[] = [];
    const actions = new ChatRefreshActions({
      state: createControllerState(),
      lifecycle: { schedule: () => {} } as never,
      getClient: () => undefined,
      post: (msg) => posted.push(msg),
      refreshSessions: vi.fn(async () => {}),
    });
    actions.publishInbox([
      {
        id: "msg_fork_notice_s1",
        sessionID: "s1",
        time: { created: 1 },
        type: "synthetic",
        delivery: "steer",
        payload: { description: "Fork notice", text: "<fork-notice>copied history</fork-notice>" },
      },
      { id: "u1", sessionID: "s1", time: { created: 2 }, type: "user", delivery: "queue", payload: { text: "queued" } },
    ]);
    expect(posted).toEqual([
      {
        type: "inbox",
        items: [{ id: "u1", sessionID: "s1", time: { created: 2 }, type: "user", delivery: "queue", payload: { text: "queued" } }],
      },
    ]);
  });

  it("ChatRefreshActions schedules refreshes and publishes inert results", async () => {
    const posted: unknown[] = [];
    const scheduled: string[] = [];
    const actions = new ChatRefreshActions({
      state: createControllerState(),
      lifecycle: { schedule: (key: string) => scheduled.push(key) } as never,
      getClient: () => undefined,
      post: (msg) => posted.push(msg),
      refreshSessions: vi.fn(async () => {}),
    });
    actions.scheduleSessions();
    actions.scheduleChanges();
    actions.scheduleInbox();
    expect(scheduled).toEqual(["sessions", "changes", "inbox"]);
    actions.publishInbox([]);
    await actions.refreshInbox();
    expect(await actions.refreshChanges()).toEqual([]);
    expect(posted).toEqual([
      { type: "inbox", items: [] },
      { type: "changedFiles", files: [] },
    ]);
  });

  it("ChatServerActions dispatches simple actions and refuses a password without an endpoint", async () => {
    const actions = new ChatServerActions({
      state: createControllerState(),
      secrets: { store: vi.fn(async () => {}), delete: vi.fn(async () => {}) } as never,
      output: { show: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      reconnect: vi.fn(async () => {}),
      openConnect: vi.fn(),
      resetServers: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      send: vi.fn(async () => true),
      saveDraft: vi.fn(async () => {}),
      post: () => {},
    });
    await actions.run("showLogs");
    await actions.run("openFolder");
    await actions.run("retry");
    await actions.setPassword();
    expect(vi.mocked((await import("vscode")).commands.executeCommand)).toHaveBeenCalledWith("vscode.openFolder");
  });
});
