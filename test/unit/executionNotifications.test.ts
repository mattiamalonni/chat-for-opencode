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
import { ChatEventRouter, type EventRouterHooks } from "../../src/chat/eventRouter";
import { BoundedSet } from "../../src/shared/boundedSet";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function routerFor() {
  const hooks: EventRouterHooks = {
    getSessionId: () => "s1",
    getFolderUri: () => undefined,
    isVisible: () => false,
    noteSessionEvent: vi.fn(),
    post: vi.fn(),
    postSessionEvent: vi.fn(),
    subagents: {
      setParent: vi.fn(),
      isTracked: vi.fn(() => false),
      track: vi.fn(),
      hasChild: vi.fn(() => false),
      snapshot: vi.fn(async () => undefined),
      forget: vi.fn(),
    },
    permissions: { forgetRequest: vi.fn(), enabled: vi.fn(() => false) },
    execution: new ExecutionStateService(),
    attention: new BoundedSet<string>(10),
    scheduleInbox: vi.fn(),
    scheduleSessions: vi.fn(),
    scheduleReconcile: vi.fn(),
    scheduleChanges: vi.fn(),
    refreshSlashItems: vi.fn(async () => undefined),
    autoApprove: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
  };
  return new ChatEventRouter(hooks);
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

    routerFor().route({ type: "session.execution.failed", data: { sessionID: "s1" } } as never);
    expect(show).toHaveBeenCalledWith("OpenCode turn failed.", "Open chat");

    show.mockClear();
    routerFor().route({ type: "session.execution.succeeded", data: { sessionID: "s1" } } as never);
    expect(show).not.toHaveBeenCalled();
  });

  it("closes the running state when a prompt is refused, but never overrides a newer turn", async () => {
    const restoreFailedPrompt = proto["restoreFailedPrompt"] as unknown as (
      this: {
        state: { failedPrompt: unknown };
        draftActions: { save: (sid: string, text: string) => Promise<void> };
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
      state: { failedPrompt: undefined },
      draftActions: { save: vi.fn(async () => undefined) },
      execution,
      post: vi.fn(),
    };

    await restoreFailedPrompt.call(c, "hello", [], [], undefined, "s1", "boom", token);
    expect(published.at(-1)).toEqual({ status: "failed", sessionId: "s1" });
    expect(c.state.failedPrompt).toMatchObject({ text: "hello", sessionId: "s1" });

    published.length = 0;
    await restoreFailedPrompt.call(c, "hello", [], [], undefined, "s1", "boom", token - 1);
    // A stale refusal must not overwrite the current turn's state.
    expect(published).toEqual([]);
  });

  it("announces a terminal event only once per turn", () => {
    const show = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    show.mockClear();
    const router = routerFor();
    const event = { type: "session.execution.failed", data: { sessionID: "s1" } } as never;

    router.route(event);
    router.route(event);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
