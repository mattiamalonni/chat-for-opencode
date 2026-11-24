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

  it("does not invalidate a load-more request when a refresh happens during it", async () => {
    const post = vi.fn();
    const second = { id: "s2", title: "Second", time: { created: 1, updated: 99 } };
    const client = {
      messages: vi.fn().mockResolvedValue([]),
      permissions: vi.fn().mockResolvedValue([]),
      forms: vi.fn().mockResolvedValue([]),
      listSessionsPage: vi
        .fn()
        .mockImplementation((_dir: string, _limit: number, cursor?: string) =>
          Promise.resolve(cursor ? { items: [second], next: undefined } : { items: [busy], next: "cursor-1" }),
        ),
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
    const loading = s.loadMore();
    // Event bursts call refresh constantly; with a single shared generation this used to throw
    // away the page the user had just asked for.
    await s.refresh();
    await loading;
    const items = post.mock.calls.at(-1)?.[0] as { items: Array<{ id: string }> };
    expect(items.items.map((i) => i.id)).toEqual(["s1", "s2"]);
  });

  it("caps concurrent deep fetches while a busy page refreshes", async () => {
    let active = 0;
    let peak = 0;
    const client = {
      messages: vi.fn().mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return [];
      }),
      permissions: vi.fn().mockResolvedValue([]),
      forms: vi.fn().mockResolvedValue([]),
      listSessionsPage: vi.fn().mockResolvedValue({
        items: Array.from({ length: 18 }, (_, i) => ({ id: `s${i}`, title: "S", time: { created: 1, updated: 100, busy: 1000 } })),
        next: undefined,
      }),
    };
    const s = new SessionListService(
      () => client as never,
      () => "/work",
      () => "other",
      new Generation(),
      vi.fn(),
      vi.fn(),
      () => 50,
    );
    await s.refresh();
    expect(client.messages).toHaveBeenCalledTimes(18);
    expect(peak).toBeLessThanOrEqual(6);
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

  const pendingPermission = { id: "perm_1", sessionID: "s1", action: "shell", resources: [] };
  const pendingForm = { id: "frm_1", sessionID: "s1", title: "Question", fields: [], metadata: {} };

  function withRequests(permissions: unknown[], forms: unknown[], autoApproves?: (sid: string) => boolean) {
    const post = vi.fn();
    const client = {
      messages: vi.fn().mockResolvedValue([]),
      permissions: vi.fn().mockResolvedValue(permissions),
      forms: vi.fn().mockResolvedValue(forms),
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
      undefined,
      autoApproves,
    );
    return { s, post };
  }

  const needsInputOf = (post: ReturnType<typeof vi.fn>) =>
    (post.mock.calls.at(-1)?.[0] as { items: Array<{ needsInput: boolean }> }).items[0].needsInput;

  it("marks a pending permission as needing input when auto-approval does not apply", async () => {
    const { s, post } = withRequests([pendingPermission], [], () => false);
    await s.refresh();
    expect(needsInputOf(post)).toBe(true);
  });

  it("does not mark a permission as needing input when it would be auto-approved on open", async () => {
    const { s, post } = withRequests([pendingPermission], [], () => true);
    await s.refresh();
    expect(needsInputOf(post)).toBe(false);
  });

  it("keeps a pending question as needing input even with auto-approval enabled", async () => {
    const { s, post } = withRequests([], [pendingForm], () => true);
    await s.refresh();
    expect(needsInputOf(post)).toBe(true);
  });

  it("still marks pending permissions as needing input when no auto-approval predicate is supplied", async () => {
    const { s, post } = withRequests([pendingPermission], []);
    await s.refresh();
    expect(needsInputOf(post)).toBe(true);
  });
});
