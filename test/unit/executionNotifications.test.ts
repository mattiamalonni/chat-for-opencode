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
import { ExecutionStateService } from "../../src/chat/executionState";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function fakeController() {
  return {
    sessionId: "s1",
    folder: undefined,
    isVisible: false,
    lastSessionEventAt: 0,
    announcedHiddenAttention: new Set<string>(),
    execution: new ExecutionStateService(),
    lifecycle: { generations: {} },
    postSessionEvent: vi.fn(),
    subagents: { isTracked: vi.fn(() => false) },
    scheduleSessions: vi.fn(),
    scheduleReconcile: vi.fn(),
  };
}

describe("host-side execution state", () => {
  it("publishes the current state on subscribe and on every transition", () => {
    const execution = new ExecutionStateService();
    const c = { execution };
    const seen: ExecutionState[] = [];
    const onDidChangeExecution = proto["onDidChangeExecution"] as unknown as (
      this: typeof c,
      listener: (state: ExecutionState) => void,
    ) => { dispose(): void };

    const sub = onDidChangeExecution.call(c, (s) => seen.push(s));
    expect(seen).toEqual([{ status: "idle", sessionId: undefined }]);
    execution.publish("running", "s1");
    expect(seen.at(-1)).toEqual({ status: "running", sessionId: "s1" });
    sub.dispose();
    execution.publish("succeeded");
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

  it("closes the running state when a prompt is refused, but never overrides a newer turn", async () => {
    const restoreFailedPrompt = proto["restoreFailedPrompt"] as unknown as (
      this: {
        failedPrompt: unknown;
        saveDraft: (sid: string, text: string) => Promise<void>;
        execution: ExecutionStateService;
        post: (msg: unknown) => void;
      },
      text: string,
      attachments: unknown[],
      context: unknown[],
      delivery: undefined,
      sid: string,
      detail: string,
      generation: number,
    ) => Promise<void>;
    const execution = new ExecutionStateService();
    const published: ExecutionState[] = [];
    execution.onDidChange((state) => published.push(state));
    const token = execution.generation.bump();
    const c = {
      failedPrompt: undefined,
      saveDraft: vi.fn(async () => undefined),
      execution,
      post: vi.fn(),
    };

    await restoreFailedPrompt.call(c, "hello", [], [], undefined, "s1", "boom", token);
    expect(published.at(-1)).toEqual({ status: "failed", sessionId: "s1" });
    expect(c.failedPrompt).toMatchObject({ text: "hello", sessionId: "s1" });

    published.length = 0;
    await restoreFailedPrompt.call(c, "hello", [], [], undefined, "s1", "boom", token - 1);
    // A stale refusal must not overwrite the current turn's state.
    expect(published).toEqual([]);
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
