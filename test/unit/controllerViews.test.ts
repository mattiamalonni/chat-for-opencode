import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { language: "en" },
  l10n: { t: (s: string) => s },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
    static from(...all: Array<{ dispose(): void }>): { dispose(): void } {
      return { dispose: () => all.forEach((d) => d.dispose()) };
    }
  },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
}));

import { ChatController } from "../../src/chat/controller";

const attachView = ChatController.prototype.attachView as unknown as (this: ReturnType<typeof fakeController>, view: FakeView) => void;
const attachPanel = ChatController.prototype.attachPanel as unknown as (this: ReturnType<typeof fakeController>, panel: FakeView) => void;
const detachView = ChatController.prototype.detachView as unknown as (this: ReturnType<typeof fakeController>, view: FakeView) => void;

/** Only the fields `attachView`/`attachPanel`/`detachView` touch — no VS Code host needed. */
function fakeController() {
  return {
    views: new Set<unknown>(),
    viewSubscriptions: new Map<unknown, { dispose(): void }>(),
    sidebarView: undefined as unknown,
    panel: undefined as unknown,
    view: undefined as unknown,
    ctx: { extensionUri: {} },
    attachView,
    attachPanel,
    detachView,
  };
}

function fakeView(kind: "sidebar" | "panel") {
  const listeners = new Map<string, Array<() => void>>();
  const on = (name: string) => (cb: () => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    return { dispose: () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb)) };
  };
  return {
    webview: {
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: on("message"),
      postMessage: () => Promise.resolve(true),
      options: {},
      html: "",
    },
    onDidDispose: on("dispose"),
    ...(kind === "sidebar" ? { onDidChangeVisibility: on("shown") } : { onDidChangeViewState: on("shown") }),
    fire(name: string): void {
      for (const cb of listeners.get(name) ?? []) cb();
    },
  };
}

type FakeView = ReturnType<typeof fakeView>;

describe("chat view handle lifecycle", () => {
  it("drops a disposed sidebar view so the recreated one can become the focus target", () => {
    const ctrl = fakeController();
    const old = fakeView("sidebar");
    attachView.call(ctrl, old);
    expect(ctrl.sidebarView).toBe(old);

    old.fire("dispose");

    expect(ctrl.sidebarView).toBeUndefined();
    const fresh = fakeView("sidebar");
    attachView.call(ctrl, fresh);
    expect(ctrl.sidebarView).toBe(fresh);
    expect(ctrl.view).toBe(fresh);
  });

  it("clears the panel handle when a restored editor tab is disposed", () => {
    const ctrl = fakeController();
    const panel = fakeView("panel");
    attachPanel.call(ctrl, panel);
    expect(ctrl.panel).toBe(panel);

    panel.fire("dispose");

    expect(ctrl.panel).toBeUndefined();
  });
});

describe("loadSession staleness", () => {
  it("does not persist or post a session that went stale during auto-approve", async () => {
    let stale = false;
    const c = {
      client: {
        messages: vi.fn().mockResolvedValue([]),
        permissions: vi.fn().mockResolvedValue([]),
        forms: vi.fn().mockResolvedValue([]),
        inbox: vi.fn().mockResolvedValue([]),
      },
      folder: { uri: { toString: () => "file:///w" } },
      output: { warn: vi.fn() },
      observeContract: vi.fn(),
      sessionId: "old",
      resetSubagents: vi.fn(),
      permissions: {
        filterPending: vi.fn(async () => {
          stale = true;
          return [];
        }),
      },
      ctx: { workspaceState: { update: vi.fn() } },
      catalog: { models: [], agents: [], publish: vi.fn() },
      post: vi.fn(),
      trackSubagent: vi.fn(),
      discoverChildren: vi.fn(),
      postAutoApprove: vi.fn(),
      publishInbox: vi.fn(),
      refreshSessions: vi.fn().mockResolvedValue(undefined),
      refreshChanges: vi.fn().mockResolvedValue([]),
      startLivePoll: vi.fn(),
    };
    const loadSession = ChatController.prototype.loadSession as unknown as (
      this: typeof c,
      info: unknown,
      stale: () => boolean,
    ) => Promise<void>;

    await loadSession.call(c, { id: "new", time: {} }, () => stale);

    expect(c.ctx.workspaceState.update).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
  });
});
