import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { language: "en" },
  l10n: { t: (s: string) => s },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
}));

import { ChatController } from "../../src/chat/controller";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const toSummaries = proto["toSummaries"] as unknown as (
  this: ReturnType<typeof fakeController>,
  sessions: unknown[],
) => Promise<Array<{ id: string; busy: boolean; needsInput: boolean }>>;

function fakeController(openSession = "other") {
  return {
    sessionId: openSession,
    summaryCache: new Map<string, { updated: number; expires: number; busy: boolean; needsInput: boolean }>(),
    client: {
      messages: vi.fn().mockResolvedValue([{ id: "m1", type: "idle", time: { created: 100 } }]),
      permissions: vi.fn().mockResolvedValue([]),
      forms: vi.fn().mockResolvedValue([]),
    },
  };
}

const busy = { id: "s1", title: "Session", time: { created: 1, updated: 100, busy: 1000, idle: 0 } };

describe("session list summaries", () => {
  it("reuses a deep fetch while the session is unchanged", async () => {
    const c = fakeController();
    const first = await toSummaries.call(c, [busy]);
    const second = await toSummaries.call(c, [busy]);

    expect(first).toEqual(second);
    expect(c.client.messages).toHaveBeenCalledTimes(1);
  });

  it("always refreshes the open session", async () => {
    const c = fakeController("s1");
    await toSummaries.call(c, [busy]);
    await toSummaries.call(c, [busy]);

    expect(c.client.messages).toHaveBeenCalledTimes(2);
  });

  it("refetches when the session was updated since the cached fetch", async () => {
    const c = fakeController();
    await toSummaries.call(c, [busy]);
    await toSummaries.call(c, [{ ...busy, time: { ...busy.time, updated: 101 } }]);

    expect(c.client.messages).toHaveBeenCalledTimes(2);
  });
});
