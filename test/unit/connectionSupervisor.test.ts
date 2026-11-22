import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  workspace: { isTrusted: true },
  window: {},
  commands: { executeCommand: vi.fn() },
}));

import { ConnectionSupervisor, type SupervisorHooks } from "../../src/chat/connectionSupervisor";
import { Generation } from "../../src/chat/generation";

const folder = { uri: { toString: () => "file:///work", fsPath: "/work" }, name: "work", index: 0 } as never;

function hooks(overrides: Partial<SupervisorHooks> = {}) {
  const server = {
    onDidChange: vi.fn(() => () => undefined),
    ensure: vi.fn().mockResolvedValue({ baseUrl: "http://localhost:1234", password: "pw" }),
    state: { status: "running", version: "2.2.7" },
  };
  const h = {
    registry: { get: vi.fn(() => server), reset: vi.fn().mockResolvedValue(undefined) },
    log: vi.fn(),
    getFolder: () => folder,
    setFolder: vi.fn(),
    pickFolder: () => folder,
    trustBlocked: () => false,
    postUntrusted: vi.fn(),
    setStatus: vi.fn(),
    getStatus: () => "idle" as const,
    generation: new Generation(),
    onReady: vi.fn().mockResolvedValue(undefined),
    onStreamReconnect: vi.fn(),
    onDetached: vi.fn(),
    toUiError: vi.fn((err: unknown) => ({ kind: "requestFailed" as const, message: String(err), actions: [] })),
    ...overrides,
  } as unknown as SupervisorHooks;
  return { server, hooks: h };
}

describe("ConnectionSupervisor", () => {
  it("deduplicates concurrent connect() calls", async () => {
    const { hooks: h } = hooks();
    const sup = new ConnectionSupervisor(h);
    const first = sup.connect();
    const second = sup.connect();
    expect(first).toBe(second);
    expect(h.registry.get).toHaveBeenCalledOnce();
    await Promise.all([first, second]);
    expect(h.onReady).toHaveBeenCalledOnce();
  });

  it("resyncs once when the stream reconnects after a disconnect", () => {
    const { hooks: h } = hooks();
    const sup = new ConnectionSupervisor(h);
    sup.onStreamStatus("connected");
    expect(h.onStreamReconnect).not.toHaveBeenCalled();
    sup.onStreamStatus("reconnecting", new Error("dropped"));
    sup.onStreamStatus("connected");
    expect(h.onStreamReconnect).toHaveBeenCalledOnce();
  });

  it("marks the connection stale after detach so late callbacks are ignored", async () => {
    const { hooks: h } = hooks();
    const sup = new ConnectionSupervisor(h);
    const stale = () => !h.generation.is(-1);
    expect(stale()).toBe(true);
    await sup.detach();
    expect(h.registry.reset).toHaveBeenCalledOnce();
    expect(h.onDetached).toHaveBeenCalledOnce();
  });
});
