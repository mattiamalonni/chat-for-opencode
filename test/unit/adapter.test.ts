import { describe, expect, it } from "vitest";
import {
  normalizeFileDiff,
  normalizeList,
  normalizeModel,
  normalizePermission,
  normalizeServerEvent,
  normalizeSessionInfo,
  normalizeSessionMessage,
  OPENAPI_SNAPSHOT_VERSION,
} from "../../src/shared/adapter";

describe("OpenCode wire adapter", () => {
  it("is pinned to the checked-in OpenAPI snapshot", () => {
    expect(OPENAPI_SNAPSHOT_VERSION).toBe("2.2.7");
  });

  it("drops malformed messages instead of sending them to the reducer", () => {
    expect(normalizeSessionMessage(null)).toBeUndefined();
    expect(normalizeSessionMessage({ type: "user" })).toBeUndefined();
    expect(normalizeList([{ id: "u1", type: "user", text: "ok", time: { created: 1 } }, {}], normalizeSessionMessage)).toHaveLength(1);
  });

  it("drops unknown message types instead of mislabelling them as system messages", () => {
    expect(normalizeSessionMessage({ id: "x", type: "brand-new-kind", time: {} })).toBeUndefined();
    const known = normalizeSessionMessage({ id: "c", type: "compaction", time: {}, text: "compacted" });
    expect(known).toMatchObject({ id: "c", type: "compaction", text: "compacted" });
  });

  it("fills optional fields so a shape drift cannot break rendering", () => {
    const message = normalizeSessionMessage({ id: "a1", type: "assistant", time: {}, content: [{ type: "text", text: "hi" }, { type: "bogus" }] });
    expect(message?.type).toBe("assistant");
    if (message?.type !== "assistant") throw new Error("expected an assistant message");
    expect(message.agent).toBe("");
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("normalises a streaming tool state and the completed version", () => {
    const base = { id: "t1", type: "tool", name: "edit", time: { created: 1 } };
    const streaming = normalizeSessionMessage({
      id: "a1", type: "assistant", agent: "build", time: { created: 1 },
      content: [{ ...base, state: { status: "streaming", input: "{\"file\":" } }],
    });
    expect(streaming?.type === "assistant" && streaming.content[0]).toMatchObject({ type: "tool", state: { status: "streaming", input: "{\"file\":" } });
    const completed = normalizeSessionMessage({
      id: "a1", type: "assistant", agent: "build", time: { created: 1 },
      content: [{ ...base, state: { status: "completed", input: { file: "a.ts" }, content: [{ type: "text", text: "done" }] } }],
    });
    expect(completed?.type === "assistant" && completed.content[0]).toMatchObject({ type: "tool", state: { status: "completed", input: { file: "a.ts" } } });
  });

  it("normalises session info, permissions, diffs and events with safe defaults", () => {
    expect(normalizeSessionInfo({ id: "s1" })).toMatchObject({ id: "s1", projectID: "", cost: 0, time: { created: 0, updated: 0 }, location: { directory: "" } });
    expect(normalizePermission({ id: "p1", sessionID: "s1", action: "edit", resources: "not-an-array" })).toMatchObject({ resources: [] });
    expect(normalizeFileDiff({ file: "a.ts", patch: "", status: "weird" })).toMatchObject({ status: "modified", additions: 0 });
    expect(normalizeServerEvent({ type: "session.status", data: { sessionID: "s1" } })).toMatchObject({ type: "session.status", data: { sessionID: "s1" } });
    expect(normalizeServerEvent({ data: {} })).toBeUndefined();
    expect(normalizeModel({ modelID: "m1", enabled: false, variants: [{ id: "high" }, {}] })).toMatchObject({ id: "m1", enabled: false, variants: [{ id: "high" }] });
  });
});
