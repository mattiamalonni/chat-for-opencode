import { describe, expect, it, vi } from "vitest";

import type { WebviewMessage } from "../../src/shared/protocol";
import { ChatCommandHandler, type CommandHandlerHooks } from "../../src/chat/commandHandler";
import { ExecutionStateService } from "../../src/chat/executionState";
import { COMPAT_DISMISSED_KEY, CONTRACT_DISMISSED_KEY } from "../../src/chat/storageKeys";

function setup(overrides: Partial<CommandHandlerHooks> = {}) {
  const update = vi.fn(async () => undefined);
  const client = {
    interrupt: vi.fn(async () => ({ interrupted: true })),
    switchModel: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ id: "s1", time: {} })),
    deleteSession: vi.fn(async () => undefined),
    setInboxDelivery: vi.fn(async () => undefined),
  };
  const hooks: CommandHandlerHooks = {
    getClient: () => client as never,
    getSessionId: () => "s1",
    getFolder: () => undefined,
    getStatus: () => "connected",
    clearFailedPrompt: vi.fn(),
    post: vi.fn(),
    postInit: vi.fn(),
    postConnection: vi.fn(),
    postDrafts: vi.fn(),
    postLocalIdle: vi.fn(),
    connect: vi.fn(async () => undefined),
    loadAll: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => undefined),
    send: vi.fn(async () => true),
    newSession: vi.fn(async () => undefined),
    saveDraft: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    setAutoApprove: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    dropFiles: vi.fn(async () => undefined),
    pickFiles: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    openAttachment: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
    runAction: vi.fn(async () => undefined),
    switchFolder: vi.fn(async () => undefined),
    refreshChanges: vi.fn(async () => []),
    syncNow: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    revertToTurn: vi.fn(async () => undefined),
    forkToTurn: vi.fn(async () => undefined),
    regenerateTurn: vi.fn(async () => undefined),
    refreshInbox: vi.fn(async () => undefined),
    deleteAllSessions: vi.fn(async () => undefined),
    catalog: { selectedModel: { id: "old", providerID: "p" }, selectModel: vi.fn(), selectAgent: vi.fn() },
    sessionList: { forget: vi.fn(), rename: vi.fn(() => true) },
    permissions: { write: vi.fn(async () => undefined) },
    subagents: { snapshot: vi.fn(async () => undefined) },
    execution: new ExecutionStateService(),
    generation: { bump: vi.fn(() => 2), current: vi.fn(() => 2), is: vi.fn(() => true) } as never,
    getFileIndex: () => undefined,
    applyCode: vi.fn(async () => undefined),
    usePrompt: vi.fn(async () => undefined),
    saveInstruction: vi.fn(async () => undefined),
    fileIcons: { resolve: vi.fn(async () => ({ icons: {}, fonts: {}, reset: false })) },
    diffs: { open: vi.fn(async () => undefined), openCombined: vi.fn(async () => undefined) },
    workspaceState: { get: vi.fn(() => ({})), update } as never,
    globalState: { get: vi.fn(), update } as never,
    t: (message: string) => message,
    confirmDanger: vi.fn(async () => undefined),
    copyToClipboard: vi.fn(async () => undefined),
    getWorkspaces: () => [],
    log: vi.fn(),
    ...overrides,
  };
  return { handler: new ChatCommandHandler(hooks), hooks, client, update };
}

const msg = <T extends WebviewMessage["type"]>(value: Extract<WebviewMessage, { type: T }>) => value;

describe("ChatCommandHandler", () => {
  it("posts the initial state and loads an already connected session on ready", async () => {
    const { handler, hooks } = setup();
    await handler.handle(msg({ type: "ready" }));
    expect(hooks.postInit).toHaveBeenCalledTimes(1);
    expect(hooks.postConnection).toHaveBeenCalledTimes(1);
    expect(hooks.postDrafts).toHaveBeenCalledTimes(1);
    expect(hooks.loadAll).toHaveBeenCalledTimes(1);
  });

  it("releases the composer even when the interrupt request fails", async () => {
    const { handler, hooks } = setup();
    const client = hooks.getClient() as unknown as { interrupt: ReturnType<typeof vi.fn> };
    client.interrupt.mockRejectedValueOnce(new Error("500"));
    await expect(handler.handle(msg({ type: "abort" }))).rejects.toThrow("500");
    // The error is still reported by receive(), but the composer must not stay locked.
    expect(hooks.postLocalIdle).toHaveBeenCalledWith("s1", expect.any(Number));
  });

  it("commits a model only after the server accepts it and restores it on failure", async () => {
    const accepted = setup();
    await accepted.handler.handle(msg({ type: "setModel", model: { id: "new", providerID: "p" } }));
    expect(accepted.client.switchModel).toHaveBeenCalledWith("s1", { id: "new", providerID: "p" });
    expect(accepted.hooks.catalog.selectModel).toHaveBeenCalledWith({ id: "new", providerID: "p" });

    const rejected = setup();
    rejected.client.switchModel.mockRejectedValueOnce(new Error("unsupported"));
    await expect(rejected.handler.handle(msg({ type: "setModel", model: { id: "bad", providerID: "p" } }))).rejects.toThrow("unsupported");
    expect(rejected.hooks.catalog.selectModel).toHaveBeenCalledWith({ id: "old", providerID: "p" });
  });

  it("persists dismissal keys without rebuilding session state", async () => {
    const { handler, hooks, update } = setup();
    await handler.handle(msg({ type: "dismissCompatibility", version: "2.9.0" }));
    await handler.handle(msg({ type: "dismissContract", signature: "sig" }));
    expect(update).toHaveBeenCalledWith(COMPAT_DISMISSED_KEY, "2.9.0");
    expect(update).toHaveBeenCalledWith(CONTRACT_DISMISSED_KEY, "sig");
    expect(hooks.postConnection).toHaveBeenCalledTimes(1);
  });

  it("delegates privileged actions through hooks instead of touching the controller", async () => {
    const { handler, hooks } = setup();
    await handler.handle(msg({ type: "action", id: "retry" }));
    await handler.handle(msg({ type: "openFile", path: "a.txt" }));
    await handler.handle(msg({ type: "sync" }));
    expect(hooks.runAction).toHaveBeenCalledWith("retry");
    expect(hooks.openFile).toHaveBeenCalledWith("a.txt");
    expect(hooks.syncNow).toHaveBeenCalledTimes(1);
  });

  it("runs the host boundary through hooks (confirmation, clipboard, workspaces)", async () => {
    const confirmed = setup({ confirmDanger: vi.fn(async () => "Delete all") });
    await confirmed.handler.handle(msg({ type: "deleteAllSessions" }));
    expect(confirmed.hooks.deleteAllSessions).toHaveBeenCalledTimes(1);

    const cancelled = setup();
    await cancelled.handler.handle(msg({ type: "deleteAllSessions" }));
    expect(cancelled.hooks.deleteAllSessions).not.toHaveBeenCalled();

    const { handler, hooks } = setup();
    await handler.handle(msg({ type: "copy", text: "hello" }));
    expect(hooks.copyToClipboard).toHaveBeenCalledWith("hello");

    const folder = { uri: { toString: () => "file:///ws" } } as never;
    const selected = setup({ getWorkspaces: () => [folder] });
    await selected.handler.handle(msg({ type: "selectFolder", uri: "file:///ws" }));
    expect(selected.hooks.switchFolder).toHaveBeenCalledWith(folder);
  });
});
