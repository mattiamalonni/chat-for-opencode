import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  window: { showWarningMessage: vi.fn(() => Promise.resolve(undefined)) },
  commands: { executeCommand: vi.fn() },
}));

import { ChatController } from "../../src/chat/controller";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function fake(isCurrent = true) {
  const client = {
    listSessionsPage: vi.fn(async () => {
      const page = client.listSessionsPage.mock.calls.length;
      return { items: Array.from({ length: 100 }, (_, i) => ({ id: `s${page}-${i}` })), next: `cursor-${page}` };
    }),
    deleteSession: vi.fn(async () => undefined),
  };
  const self = {
    client,
    folder: { uri: { fsPath: "/work", toString: () => "file:///work" } },
    sessionId: "s1",
    deleteAllAbort: undefined as AbortController | undefined,
    deleteGeneration: { current: () => 1, is: () => isCurrent, bump: vi.fn() },
    lifecycle: { generations: {} },
    output: { warn: vi.fn() },
    sessionList: { forget: vi.fn() },
    permissions: { write: vi.fn(async () => undefined) },
    ctx: { workspaceState: { get: vi.fn(() => ({ drafts: {} })), update: vi.fn(async () => undefined) } },
    refreshSessions: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
  };
  return { self, client };
}

const callDeleteAll = (self: unknown): Promise<void> => (proto["deleteAllSessions"] as (this: unknown) => Promise<void>).call(self);

describe("deleteAllSessions", () => {
  it("stops after a bounded number of pages instead of following an endless cursor", async () => {
    const { self, client } = fake();
    await expect(callDeleteAll(self)).rejects.toThrow(/Too many session pages/);
    expect(client.listSessionsPage).toHaveBeenCalledTimes(100);
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(self.deleteAllAbort).toBeUndefined();
  });

  it("does not delete anything once the folder generation went stale", async () => {
    const { self, client } = fake(false);
    await callDeleteAll(self);
    expect(client.listSessionsPage).not.toHaveBeenCalled();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });
});
