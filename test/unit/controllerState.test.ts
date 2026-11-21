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

const proto = ChatController.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>;
const call = (name: string, self: unknown, ...args: unknown[]): unknown => proto[name].apply(self, args);

function base(extra: Record<string, unknown> = {}) {
  const gens = {
    execution: { current: () => 7, is: (n: number) => n === 7, bump: vi.fn() },
    connect: { current: () => 1, is: () => true, bump: vi.fn() },
    load: { current: () => 1, is: () => true, bump: vi.fn() },
  };
  const self: Record<string, unknown> = {
    status: "idle",
    lastError: undefined,
    version: undefined,
    wasDisconnected: false,
    contract: { failures: [] },
    contractObservations: {},
    sessionId: "s1",
    executionState: "idle",
    executionListeners: new Set(),
    post: vi.fn(),
    output: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ctx: { globalState: { get: vi.fn(() => undefined), update: vi.fn() } },
    lifecycle: { generations: gens, schedule: vi.fn(), cancel: vi.fn(), clearAll: vi.fn() },
    chatViews: { hasPrimary: true, isVisible: false },
    ...extra,
  };
  // Bind the small helper methods the ones under test call, without constructing the controller.
  for (const name of ["postConnection", "postUntrusted", "publishExecution", "setStatus", "scheduleSessions"]) {
    self[name] = (...args: unknown[]) => call(name, self, ...args);
  }
  return self;
}

describe("ChatController state machine", () => {
  it("setStatus publishes the connection state to the webview", () => {
    const c = base();
    call("setStatus", c, "reconnecting");
    expect(c.status).toBe("reconnecting");
    expect(c.post).toHaveBeenCalledWith(expect.objectContaining({ type: "connection", status: "reconnecting" }));
  });

  it("postLocalIdle ignores a generation that went stale during the request", () => {
    const stale = base();
    call("postLocalIdle", stale, "s1", 6);
    expect(stale.post).not.toHaveBeenCalled();

    const current = base();
    call("postLocalIdle", current, "s1", 7);
    expect(current.post).toHaveBeenCalledWith({
      type: "event",
      event: { type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } },
    });
  });

  it("stops servers and posts an untrusted notice when trust is revoked", async () => {
    const c = base();
    const detach = vi.fn().mockResolvedValue(undefined);
    (c as Record<string, unknown>).detachServers = detach;
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
    await call("syncNow", c);
    expect(c.post).toHaveBeenCalledWith({ type: "synced" });
  });

});
