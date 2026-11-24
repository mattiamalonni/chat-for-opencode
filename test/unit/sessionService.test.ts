import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
}));

import type { ConnectionStatus, HostMessage, UiError } from "../../src/shared/protocol";
import { BoundedSet } from "../../src/shared/boundedSet";
import { CatalogService } from "../../src/chat/catalogService";
import { ChatLifecycle } from "../../src/chat/lifecycle";
import { createControllerState } from "../../src/chat/services/controllerState";
import { ChatSessionService, type SessionServiceDeps } from "../../src/chat/services/sessionService";

/** Let the async `loadAll()` started by a scheduled retry finish. */
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function setup(initialModels: unknown[]) {
  let models = initialModels;
  const scheduled: Array<() => void> = [];
  const statuses: Array<{ status: ConnectionStatus; error?: UiError }> = [];
  const posted: HostMessage[] = [];
  const state = createControllerState();
  state.folder = { uri: { toString: () => "file:///w", fsPath: "/w" } } as never;
  const ctx = {
    globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) },
    workspaceState: { get: vi.fn(() => undefined) },
  } as never;
  const catalog = new CatalogService(
    ctx,
    (msg) => posted.push(msg),
    () => {},
    () => true,
  );
  const client = {
    models: vi.fn(async () => models as never),
    defaultModel: vi.fn(async () => null),
    agents: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "tmp" })),
    deleteSession: vi.fn(async () => undefined),
    skills: vi.fn(async () => []),
    commands: vi.fn(async () => []),
  };
  const lifecycle = new ChatLifecycle();
  vi.spyOn(lifecycle, "schedule").mockImplementation((_name, fn) => {
    scheduled.push(fn);
  });
  const deps: SessionServiceDeps = {
    state,
    ctx,
    output: { warn: vi.fn(), info: vi.fn() } as never,
    lifecycle,
    execution: {} as never,
    catalog,
    context: { current: () => [] } as never,
    subagents: { reset: vi.fn() } as never,
    permissions: {} as never,
    attention: new BoundedSet<string>(10),
    permissionActions: { post: vi.fn() } as never,
    refreshActions: {} as never,
    getClient: () => client as never,
    isVisible: () => true,
    abortConnectionRequests: vi.fn(),
    clearTimers: vi.fn(),
    post: (msg) => posted.push(msg),
    setStatus: (status, error) => statuses.push({ status, error }),
    observeContract: vi.fn(),
    bestEffort: (async (_label: string, promise: Promise<unknown>) => await promise) as SessionServiceDeps["bestEffort"],
    refreshSessions: vi.fn(async () => undefined),
  };
  return {
    service: new ChatSessionService(deps),
    client,
    catalog,
    state,
    statuses,
    scheduled,
    posted,
    setModels: (value: unknown[]) => {
      models = value;
    },
  };
}

const MODEL = { id: "m1", providerID: "p1", name: "Model 1" };

describe("ChatSessionService catalog readiness", () => {
  it("retries an empty model snapshot before reporting a missing provider", async () => {
    const t = setup([]);
    await t.service.loadAll();
    expect(t.scheduled).toHaveLength(1);
    expect(t.statuses.some((s) => s.error?.kind === "noProvider")).toBe(false);

    t.setModels([MODEL]);
    t.scheduled.shift()!();
    await flush();
    expect(t.client.models).toHaveBeenCalledTimes(2);
    expect(t.statuses.at(-1)?.status).toBe("connected");
    expect(t.catalog.models.map((m) => m.id)).toEqual(["m1"]);
  });

  it("reports noProvider only after the retries are exhausted", async () => {
    const t = setup([]);
    await t.service.loadAll();
    for (let i = 0; i < 3; i++) {
      expect(t.scheduled).toHaveLength(1);
      t.scheduled.shift()!();
      await flush();
    }
    expect(t.scheduled).toHaveLength(0);
    expect(t.client.models).toHaveBeenCalledTimes(4);
    expect(t.statuses.at(-1)?.error?.kind).toBe("noProvider");
    expect(t.state.catalogRetries).toBe(3);
  });

  it("shows a failed catalog request immediately and still schedules a retry", async () => {
    const t = setup([]);
    t.client.models.mockRejectedValueOnce(new Error("boom"));
    await t.service.loadAll();
    expect(t.statuses.at(-1)?.error?.kind).toBe("requestFailed");
    expect(t.scheduled).toHaveLength(1);
  });
});
