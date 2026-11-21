import { describe, expect, it, vi } from "vitest";
import { Generation } from "../../src/chat/generation";
import { SubagentTracker } from "../../src/chat/subagentTracker";

function tracker(sessionId = "parent") {
  const post = vi.fn();
  const client = {
    getSession: vi.fn().mockResolvedValue(undefined),
    messages: vi.fn().mockResolvedValue([]),
    permissions: vi.fn().mockResolvedValue([]),
    forms: vi.fn().mockResolvedValue([]),
    listChildSessions: vi.fn().mockResolvedValue([]),
  };
  const t = new SubagentTracker(
    () => client as never,
    () => sessionId,
    () => "/work",
    new Generation(),
    post,
    vi.fn(),
    async () => [],
    () => false,
  );
  return { t, post, client };
}

describe("SubagentTracker", () => {
  it("follows nested children by their parent chain", () => {
    const { t } = tracker();
    t.setParent("child", "parent");
    t.setParent("grandchild", "child");
    expect(t.isTracked("child")).toBe(true);
    expect(t.isTracked("grandchild")).toBe(true);
    expect(t.isTracked("unrelated")).toBe(false);
  });

  it("routes live events of unknown sessions nowhere", () => {
    const { t, post } = tracker();
    const event = { type: "session.status", data: { sessionID: "unrelated" } };
    t.postEvent("unrelated", event as never);
    expect(post).not.toHaveBeenCalled();
  });

  it("routes the open session's events to the chat", () => {
    const { t, post } = tracker();
    const event = { type: "session.status", data: { sessionID: "parent" } };
    t.postEvent("parent", event as never);
    expect(post).toHaveBeenCalledWith({ type: "event", event });
  });

  it("forgets a deleted child", () => {
    const { t } = tracker();
    t.setParent("child", "parent");
    t.track("child");
    expect(t.hasChild("child")).toBe(true);
    t.forget("child");
    expect(t.hasChild("child")).toBe(false);
  });
});
