import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  commands: { executeCommand: vi.fn() },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
}));

import { ChatController, type SessionSearchResult } from "../../src/chat/controller";

const proto = ChatController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const searchSessions = proto["searchSessions"] as unknown as (
  this: ReturnType<typeof fakeController>,
  query: string,
) => Promise<SessionSearchResult[]>;

function fakeController() {
  return {
    sessionId: "other",
    folder: { uri: { fsPath: "/work" } },
    client: {
      listSessionsPage: vi.fn().mockResolvedValue({
        items: [
          { id: "s1", title: "Auth bug", time: { created: 1, updated: 100 } },
          { id: "s2", title: "Refactor", time: { created: 1, updated: 200 } },
        ],
        next: undefined,
      }),
      messages: vi.fn((id: string) =>
        Promise.resolve(id === "s2" ? [{ id: "m2", type: "user", text: "please fix the auth flow", time: { created: 2 } }] : []),
      ),
    },
  };
}

describe("cross-session search", () => {
  it("finds title hits and message hits and orders them by recency", async () => {
    const c = fakeController();
    const hits = await searchSessions.call(c, "auth");

    expect(hits.map((h) => h.sessionId)).toEqual(["s2", "s1"]);
    expect(hits[0]).toMatchObject({ messageId: "m2" });
    expect(hits[0].snippet).toContain("auth flow");
    expect(hits[1].snippet).toBe("Title match");
  });

  it("does nothing without a connected client or a query", async () => {
    const c = fakeController();
    expect(await searchSessions.call(c, "   ")).toEqual([]);
    const withoutClient = { ...c, client: undefined } as never;
    expect(await searchSessions.call(withoutClient, "auth")).toEqual([]);
  });
});
