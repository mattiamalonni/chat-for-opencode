import { describe, expect, it, vi } from "vitest";
import { Generation } from "../../src/chat/generation";
import { SessionListService } from "../../src/chat/sessionListService";

function service(openSession = "other") {
  const client = {
    messages: vi.fn().mockResolvedValue([{ id: "m1", type: "idle", time: { created: 100 } }]),
    permissions: vi.fn().mockResolvedValue([]),
    forms: vi.fn().mockResolvedValue([]),
    listSessionsPage: vi.fn().mockResolvedValue({ items: [], next: undefined }),
  };
  const s = new SessionListService(
    () => client as never,
    () => "/work",
    () => openSession,
    new Generation(),
    vi.fn(),
    vi.fn(),
    () => 10,
  );
  // `toSummaries` is private; exercise it through `refresh()` with a one-session list, which is the
  // same path the controller uses after every event burst.
  client.listSessionsPage.mockResolvedValue({ items: [busy], next: undefined });
  return { s, client };
}

const busy = { id: "s1", title: "Session", time: { created: 1, updated: 100, busy: 1000, idle: 0 } };

describe("session list summaries", () => {
  it("reuses a deep fetch while the session is unchanged", async () => {
    const { s, client } = service();
    await s.refresh();
    await s.refresh();

    expect(client.messages).toHaveBeenCalledTimes(1);
  });

  it("always refreshes the open session", async () => {
    const { s, client } = service("s1");
    await s.refresh();
    await s.refresh();

    expect(client.messages).toHaveBeenCalledTimes(2);
  });

  it("refetches when the session was updated since the cached fetch", async () => {
    const { s, client } = service();
    await s.refresh();
    client.listSessionsPage.mockResolvedValue({ items: [{ ...busy, time: { ...busy.time, updated: 101 } }], next: undefined });
    await s.refresh();

    expect(client.messages).toHaveBeenCalledTimes(2);
  });

  it("posts the summaries to the webview", async () => {
    const post = vi.fn();
    const client = {
      messages: vi.fn().mockResolvedValue([{ id: "m1", type: "idle", time: { created: 100 } }]),
      permissions: vi.fn().mockResolvedValue([]),
      forms: vi.fn().mockResolvedValue([]),
      listSessionsPage: vi.fn().mockResolvedValue({ items: [busy], next: undefined }),
    };
    const s = new SessionListService(
      () => client as never,
      () => "/work",
      () => "other",
      new Generation(),
      post,
      vi.fn(),
      () => 10,
    );
    await s.refresh();
    expect(post).toHaveBeenCalledWith({
      type: "sessions",
      items: [expect.objectContaining({ id: "s1", busy: false })],
      currentId: "other",
      hasMore: false,
    });
  });
});
