import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: boolean) => fallback }),
  },
  window: { showInformationMessage: vi.fn(() => Promise.resolve(undefined)) },
  commands: { executeCommand: vi.fn() },
}));

import * as vscode from "vscode";
import { ChatController, type ExecutionState } from "../../src/chat/controller";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function fakeController(notifyComplete = false) {
  return {
    sessionId: "s1",
    folder: undefined,
    isVisible: false,
    lastSessionEventAt: 0,
    announcedHiddenAttention: new Set<string>(),
    executionGen: { current: () => 7, bump: vi.fn() },
    postSessionEvent: vi.fn(),
    isTrackedSession: vi.fn(() => false),
    scheduleSessions: vi.fn(),
    scheduleReconcile: vi.fn(),
    publishExecution: vi.fn(),
    notifyComplete,
  };
}

describe("host-side execution state", () => {
  it("publishes the current state on subscribe and on every transition", () => {
    const c = {
      sessionId: "s1",
      executionState: "idle",
      executionListeners: new Set<(state: ExecutionState) => void>(),
    };
    const seen: ExecutionState[] = [];
    const onDidChangeExecution = proto["onDidChangeExecution"] as unknown as (
      this: typeof c,
      listener: (state: ExecutionState) => void,
    ) => { dispose(): void };
    const publishExecution = proto["publishExecution"] as unknown as (this: typeof c, status: ExecutionState["status"]) => void;

    const sub = onDidChangeExecution.call(c, (s) => seen.push(s));
    expect(seen).toEqual([{ status: "idle", sessionId: "s1" }]);
    publishExecution.call(c, "running");
    expect(seen.at(-1)).toEqual({ status: "running", sessionId: "s1" });
    sub.dispose();
    publishExecution.call(c, "succeeded");
    expect(seen).toHaveLength(2);
  });

  it("announces a failed turn while hidden, but not a successful one by default", () => {
    const show = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    show.mockClear();
    const onEvent = proto["onEvent"] as unknown as (this: ReturnType<typeof fakeController>, event: unknown) => void;

    onEvent.call(fakeController(), { type: "session.execution.failed", data: { sessionID: "s1" } });
    expect(show).toHaveBeenCalledWith("OpenCode turn failed.", "Open chat");

    show.mockClear();
    onEvent.call(fakeController(), { type: "session.execution.succeeded", data: { sessionID: "s1" } });
    expect(show).not.toHaveBeenCalled();
  });

  it("announces a terminal event only once per turn", () => {
    const show = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    show.mockClear();
    const onEvent = proto["onEvent"] as unknown as (this: ReturnType<typeof fakeController>, event: unknown) => void;
    const c = fakeController();
    const event = { type: "session.execution.failed", data: { sessionID: "s1" } };

    onEvent.call(c, event);
    onEvent.call(c, event);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
