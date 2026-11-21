import { describe, expect, it, vi } from "vitest";
import { Generation } from "../../src/chat/generation";
import { SessionListService, type SessionSearchResult } from "../../src/chat/sessionListService";

function service(withClient = true) {
  const client = withClient
    ? {
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
      }
    : undefined;
  return new SessionListService(
    () => client as never,
    () => "/work",
    () => "other",
    new Generation(),
    vi.fn(),
    vi.fn(),
    () => 10,
  );
}

describe("cross-session search", () => {
  it("finds title hits and message hits and orders them by recency", async () => {
    const hits: SessionSearchResult[] = await service().search("auth");

    expect(hits.map((h) => h.sessionId)).toEqual(["s2", "s1"]);
    expect(hits[0]).toMatchObject({ messageId: "m2" });
    expect(hits[0].snippet).toContain("auth flow");
    expect(hits[1].snippet).toBe("Title match");
  });

  it("does nothing without a connected client or a query", async () => {
    expect(await service().search("   ")).toEqual([]);
    expect(await service(false).search("auth")).toEqual([]);
  });
});
