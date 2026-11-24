import { describe, expect, it } from "vitest";

import { ExternalAttentionService } from "../../src/chat/externalAttention";
import type { ServerEvent } from "../../src/shared/api";
import type { ExternalAttentionItem, HostMessage } from "../../src/shared/protocol";

function setup() {
  const posted: HostMessage[] = [];
  const service = new ExternalAttentionService(
    (msg) => posted.push(msg),
    (sid) => (sid === "other" ? "Other chat" : undefined),
  );
  const items = (): ExternalAttentionItem[] => {
    const last = posted.filter((m): m is Extract<HostMessage, { type: "externalAttention" }> => m.type === "externalAttention").at(-1);
    return last?.items ?? [];
  };
  const event = (type: string, data: Record<string, unknown>): ServerEvent => ({ type, data }) as ServerEvent;
  return { service, posted, items, event };
}

const permission = (sid: string, id: string) => ({
  sessionID: sid,
  id,
  action: "edit",
  resources: ["a.txt"],
  save: [],
  metadata: {},
});

describe("ExternalAttentionService", () => {
  it("publishes a pending request from another session with its title", () => {
    const { service, items, event } = setup();
    service.observe(event("permission.asked", permission("other", "req-1")), "other", false, false);
    expect(items()).toEqual([{ sessionId: "other", label: "Other chat", permission: expect.objectContaining({ id: "req-1" }) }]);
  });

  it("ignores the open chat and tracked children, which already render their own cards", () => {
    const { service, posted, event } = setup();
    service.observe(event("permission.asked", permission("s1", "req-current")), "s1", true, false);
    service.observe(event("permission.asked", permission("child", "req-child")), "child", false, true);
    expect(posted).toEqual([]);
  });

  it("replaces a duplicate event instead of stacking a second card", () => {
    const { service, items, event } = setup();
    const data = permission("other", "req-1");
    service.observe(event("permission.asked", data), "other", false, false);
    service.observe(event("permission.asked", data), "other", false, false);
    expect(items()).toHaveLength(1);
  });

  it("collects form questions from the form payload", () => {
    const { service, items, event } = setup();
    service.observe(
      event("form.created", { form: { id: "form-1", sessionID: "other", title: "Pick one", fields: [{ key: "a", type: "string" }] } }),
      "other",
      false,
      false,
    );
    expect(items()).toEqual([{ sessionId: "other", label: "Other chat", question: expect.objectContaining({ id: "form-1" }) }]);
  });

  it("drops answered requests and requests of deleted sessions", () => {
    const { service, items, event } = setup();
    service.observe(event("permission.asked", permission("other", "req-1")), "other", false, false);
    service.observe(event("permission.replied", { sessionID: "other", requestID: "req-1" }), "other", true, false);
    expect(items()).toEqual([]);

    service.observe(event("form.created", { form: { id: "form-1", sessionID: "other", fields: [] } }), "other", false, false);
    service.observe(event("session.deleted", { sessionID: "other" }), "other", false, false);
    expect(items()).toEqual([]);
  });

  it("forgets a session when it becomes the open chat and resets on a new server", () => {
    const { service, items, event } = setup();
    service.observe(event("permission.asked", permission("other", "req-1")), "other", false, false);
    expect(service.forget("other")).toBe(true);
    expect(items()).toEqual([]);

    service.observe(event("permission.asked", permission("other", "req-2")), "other", false, false);
    service.reset();
    expect(items()).toEqual([]);
  });
});
