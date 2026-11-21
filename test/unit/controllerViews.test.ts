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
import { ChatViews } from "../../src/chat/views";

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
    visible: true,
    fire(name: string): void {
      for (const cb of listeners.get(name) ?? []) cb();
    },
  };
}

function makeViews(onShown: (view: unknown) => void = () => {}) {
  return new ChatViews({} as never, () => {}, onShown as never);
}

describe("chat view handle lifecycle", () => {
  it("drops a disposed sidebar view so the recreated one can become the focus target", () => {
    const views = makeViews();
    const old = fakeView("sidebar");
    views.attachView(old as never);
    expect(views.size).toBe(1);

    old.fire("dispose");
    expect(views.size).toBe(0);

    const fresh = fakeView("sidebar");
    views.attachView(fresh as never);
    expect(views.size).toBe(1);
    expect(views.hasPrimary).toBe(true);
    expect(views.has(fresh as never)).toBe(true);
  });

  it("clears the panel handle when a restored editor tab is disposed", () => {
    const views = makeViews();
    const panel = fakeView("panel");
    views.attachPanel(panel as never);
    expect(views.hasPanel).toBe(true);

    panel.fire("dispose");
    expect(views.hasPanel).toBe(false);

    // A second attach must not find a stale panel to reveal; it simply registers the fresh one.
    const fresh = fakeView("panel");
    views.attachPanel(fresh as never);
    expect(views.has(fresh as never)).toBe(true);
    expect(views.hasPanel).toBe(true);
  });

  it("only calls the shown callback while the view is still attached and visible", () => {
    let calls = 0;
    const views = makeViews(() => { calls++; });
    const view = fakeView("sidebar");
    views.attachView(view as never);
    view.fire("shown");
    expect(calls).toBe(1);
    view.visible = false;
    view.fire("shown");
    expect(calls).toBe(1);
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
    const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const fn = proto["loadSession"] as unknown as (
      this: typeof c,
      info: unknown,
      stale: () => boolean,
    ) => Promise<void>;

    await fn.call(c, { id: "new", time: {} }, () => stale);

    expect(c.ctx.workspaceState.update).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
  });
});
