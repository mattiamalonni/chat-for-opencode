import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  env: { language: "en", clipboard: { writeText: vi.fn() } },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    workspaceFolders: [],
  },
  window: { showInformationMessage: vi.fn(() => Promise.resolve(undefined)), activeColorTheme: { kind: 1 } },
  commands: { executeCommand: vi.fn() },
  extensions: { all: [], onDidChange: () => ({ dispose() {} }) },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") }) },
}));

import { ChatController } from "../../src/chat/controller";
import { ExecutionStateService } from "../../src/chat/executionState";
import { ChatSessionService } from "../../src/chat/services/sessionService";

const proto = ChatController.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>;
const call = (name: string, self: unknown, ...args: unknown[]): unknown => proto[name].apply(self, args);

function base(extra: Record<string, unknown> = {}) {
  const gens = {
    connect: { current: () => 1, is: () => true, bump: vi.fn() },
    load: { current: () => 1, is: () => true, bump: vi.fn() },
  };
  const state: Record<string, unknown> = {
    status: "idle",
    lastError: undefined,
    version: undefined,
    contract: { failures: [] },
    contractObservations: {},
    sessionId: "s1",
  };
  // A few tests override a moved scalar with the old flat key; route it to the shared state.
  for (const key of ["status", "sessionId", "folder", "lastError", "version", "contract", "contractObservations"]) {
    if (key in extra && extra[key] !== undefined) state[key] = extra[key];
  }
  const self: Record<string, unknown> = {
    state,
    wasDisconnected: false,
    execution: new ExecutionStateService(),
    post: vi.fn(),
    refreshActions: { scheduleSessions: vi.fn() },
    sessionService: { scheduleReconcile: vi.fn(), syncNow: vi.fn() },
    scheduleReconcile: vi.fn(),
    output: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ctx: { globalState: { get: vi.fn(() => undefined), update: vi.fn() } },
    lifecycle: { generations: gens, schedule: vi.fn(), cancel: vi.fn(), clearAll: vi.fn() },
    chatViews: { hasPrimary: true, isVisible: false },
    ...extra,
  };
  // Bind the small helper methods the ones under test call, without constructing the controller.
  for (const name of ["postConnection", "postUntrusted", "setStatus", "scheduleSessions"]) {
    self[name] = (...args: unknown[]) => call(name, self, ...args);
  }
  return self;
}

describe("ChatController state machine", () => {
  it("setStatus publishes the connection state to the webview", () => {
    const c = base();
    call("setStatus", c, "reconnecting");
    expect((c.state as Record<string, unknown>).status).toBe("reconnecting");
    expect(c.post).toHaveBeenCalledWith(expect.objectContaining({ type: "connection", status: "reconnecting" }));
  });

  it("postLocalIdle ignores a generation that went stale during the request", () => {
    const stale = base();
    for (let i = 0; i < 7; i++) (stale.execution as ExecutionStateService).generation.bump();
    call("postLocalIdle", stale, "s1", 6);
    expect(stale.post).not.toHaveBeenCalled();

    const current = base();
    for (let i = 0; i < 7; i++) (current.execution as ExecutionStateService).generation.bump();
    call("postLocalIdle", current, "s1", 7);
    expect(current.post).toHaveBeenCalledWith({
      type: "event",
      event: { type: "session.status", data: { sessionID: "s1", status: { type: "idle", local: true } } },
    });
    expect((current.sessionService as { scheduleReconcile: ReturnType<typeof vi.fn> }).scheduleReconcile).toHaveBeenCalled();
  });

  it("stops servers and posts an untrusted notice when trust is revoked", async () => {
    const c = base();
    const detach = vi.fn().mockResolvedValue(undefined);
    (c as Record<string, unknown>).connectionService = {
      onWorkspaceTrustChanged: async (trusted: boolean) => {
        if (!trusted) {
          await detach();
          (c.postUntrusted as () => void)();
        }
      },
    };
    await call("onWorkspaceTrustChanged", c, false);
    expect(detach).toHaveBeenCalledOnce();
    expect(c.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection",
        error: expect.objectContaining({ kind: "untrustedWorkspace", actions: ["trustWorkspace"] }),
      }),
    );
  });

  it("always releases the manual-sync button, even with no client", async () => {
    const c = base({ client: undefined, sessionId: undefined });
    const service = ChatSessionService.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>;
    await service["syncNow"].call({ d: { getClient: () => undefined, state: c.state, post: c.post } });
    expect(c.post).toHaveBeenCalledWith({ type: "synced" });
  });

  it("leaves focus in the composer after opening a session from the picker", async () => {
    const receive = vi.fn().mockResolvedValue(undefined);
    const c = base({ receive });
    await call("openSearchResult", c, { sessionId: "s2", title: "Other chat", snippet: "", updated: 0, messageId: "m1" });
    expect(receive).toHaveBeenCalledWith({ type: "selectSession", id: "s2" });
    expect(c.post).toHaveBeenCalledWith({ type: "revealMessage", messageId: "m1", sessionId: "s2" });
    expect(c.post).toHaveBeenCalledWith({ type: "focusInput" });
  });
});
