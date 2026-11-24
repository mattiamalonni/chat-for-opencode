import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  window: { showInformationMessage: vi.fn(() => Promise.resolve(undefined)) },
  commands: { executeCommand: vi.fn() },
}));

import { ChatEventRouter, type EventRouterHooks } from "../../src/chat/eventRouter";
import { ExecutionStateService } from "../../src/chat/executionState";
import { BoundedSet } from "../../src/shared/boundedSet";
import type { ServerEvent } from "../../src/shared/api";

function setup(overrides: Partial<EventRouterHooks> = {}) {
  const subagents = {
    setParent: vi.fn(),
    isTracked: vi.fn(() => false),
    track: vi.fn(),
    hasChild: vi.fn(() => false),
    snapshot: vi.fn(async () => undefined),
    forget: vi.fn(),
  };
  const hooks: EventRouterHooks = {
    getSessionId: () => "s1",
    getFolderUri: () => undefined,
    isVisible: () => true,
    noteSessionEvent: vi.fn(),
    post: vi.fn(),
    postSessionEvent: vi.fn(),
    subagents,
    permissions: { forgetRequest: vi.fn(), enabled: vi.fn(() => false) },
    external: { observe: vi.fn(), forget: vi.fn() },
    execution: new ExecutionStateService(),
    attention: new BoundedSet<string>(10),
    scheduleInbox: vi.fn(),
    scheduleSessions: vi.fn(),
    scheduleReconcile: vi.fn(),
    scheduleChanges: vi.fn(),
    refreshSlashItems: vi.fn(async () => undefined),
    autoApprove: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return { router: new ChatEventRouter(hooks), hooks, subagents };
}

const event = (type: string, data: Record<string, unknown>): ServerEvent => ({ type, data }) as ServerEvent;

describe("ChatEventRouter", () => {
  it("posts an explicit subagent link by tool id and tracks the child", () => {
    const { router, hooks, subagents } = setup();
    router.route(event("session.tool.progress", { sessionID: "s1", id: "tool-1", metadata: { sessionID: "child-1" } }));
    expect(subagents.track).toHaveBeenCalledWith("child-1");
    expect(hooks.post).toHaveBeenCalledWith({ type: "linkSubagent", toolId: "tool-1", sessionId: "child-1" });
  });

  it("auto-approves a child permission without posting it to the chat", () => {
    const { router, hooks, subagents } = setup();
    subagents.isTracked.mockReturnValue(true);
    (hooks.permissions.enabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    router.route(event("permission.asked", { sessionID: "child-1", id: "req-1" }));
    expect(hooks.autoApprove).toHaveBeenCalledTimes(1);
    expect(hooks.postSessionEvent).not.toHaveBeenCalled();
  });

  it("hands permission requests from other sessions to the external attention owner", () => {
    const { router, hooks, subagents } = setup();
    router.route(event("permission.asked", { sessionID: "other", id: "req-ext" }));
    expect(hooks.external.observe).toHaveBeenCalledWith(expect.objectContaining({ type: "permission.asked" }), "other", false, false);

    subagents.isTracked.mockReturnValue(true);
    router.route(event("permission.asked", { sessionID: "child-1", id: "req-child" }));
    expect(hooks.external.observe).toHaveBeenLastCalledWith(expect.anything(), "child-1", false, true);
  });

  it("schedules a refresh when a completed step reports changed files", () => {
    const { router, hooks } = setup();
    router.route(event("session.step.ended", { sessionID: "s1", files: ["a.txt"] }));
    expect(hooks.scheduleChanges).toHaveBeenCalledTimes(1);
    router.route(event("session.step.ended", { sessionID: "s1", files: [] }));
    expect(hooks.scheduleChanges).toHaveBeenCalledTimes(1);
  });

  it("publishes terminal status through the single execution owner", () => {
    const { router, hooks } = setup();
    router.route(event("session.execution.started", { sessionID: "s1" }));
    expect(hooks.execution.state.status).toBe("running");
    router.route(event("session.execution.succeeded", { sessionID: "s1" }));
    expect(hooks.execution.state.status).toBe("succeeded");
    expect(hooks.scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed events and events from other sessions for turn state", () => {
    const { router, hooks } = setup();
    router.route(event("not.a.server.event", { sessionID: "s1" }));
    router.route(event("session.execution.failed", { sessionID: "other" }));
    expect(hooks.execution.state.status).toBe("idle");
    expect(hooks.scheduleReconcile).not.toHaveBeenCalled();
  });
});
