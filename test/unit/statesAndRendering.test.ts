import { describe, expect, it } from "vitest";
import type { ServerEvent, SessionMessage } from "../../src/shared/api";
import { backgroundNotice, chatReducer, initialChatState, selectPendingShells } from "../../src/shared/chatReducer";
import { parseBackgroundResult } from "../../src/shared/backgroundResult";

const SID = "ses_states";

function open(messages: SessionMessage[] = []) {
  return chatReducer(initialChatState, { type: "load", sessionId: SID, messages, permissions: [], forms: [] });
}

function event(type: string, data: Record<string, unknown>): ServerEvent {
  return { type, data: { sessionID: SID, ...data } } as ServerEvent;
}

describe("compaction state", () => {
  it("shows running and failed compactions instead of reporting success", () => {
    const started = chatReducer(open(), { type: "event", event: event("session.compaction.started", { reason: "auto" }) });
    expect(started.messages.some((m) => m.kind === "notice" && m.code === "compacting")).toBe(true);

    const failed = chatReducer(started, {
      type: "event",
      event: event("session.compaction.failed", { error: { type: "api", message: "context too large" } }),
    });
    expect(failed.messages.some((m) => m.kind === "notice" && m.code === "compacting")).toBe(false);
    expect(failed.messages.some((m) => m.kind === "notice" && m.code === "compactionFailed")).toBe(true);
    expect(JSON.stringify(failed.messages)).toContain("context too large");

    const ended = chatReducer(started, { type: "event", event: event("session.compaction.ended", {}) });
    expect(ended.messages.some((m) => m.kind === "notice" && m.code === "compaction")).toBe(true);
    expect(ended.messages.some((m) => m.kind === "notice" && m.code === "compacting")).toBe(false);
  });

  it("reads compaction status from history", () => {
    const base = { id: "c1", type: "compaction" as const, time: { created: 1 }, text: "" };
    const running = open([{ ...base, status: "running" } as SessionMessage]);
    expect(running.messages.find((m) => m.kind === "notice")?.code).toBe("compacting");
    const failed = open([{ ...base, status: "failed", description: "boom" } as SessionMessage]);
    expect(failed.messages.find((m) => m.kind === "notice")?.code).toBe("compactionFailed");
  });
});

describe("user shells and queue delivery", () => {
  it("tracks a running user shell until it ends or its result arrives", () => {
    const started = chatReducer(open(), {
      type: "event",
      event: event("session.shell.started", { shell: { id: "sh_user", status: "running", command: "npm test" } }),
    });
    const notice = started.messages.find((m) => m.kind === "notice");
    expect(notice?.code).toBe("userShell");
    expect(selectPendingShells(started)).toEqual([]); // user shells are notices, not agent tool calls

    const ended = chatReducer(started, {
      type: "event",
      event: event("session.shell.ended", { shell: { id: "sh_user", status: "exited" } }),
    });
    expect(ended.messages.some((m) => m.kind === "notice" && m.code === "userShell")).toBe(false);
  });

  it("drops a queued prompt when its delivery changes to steer", () => {
    const queued = chatReducer(open(), {
      type: "event",
      event: event("session.inbox.enqueued", {
        inboxID: "q1",
        item: { id: "q1", type: "user", delivery: "queue", payload: { text: "hello" } },
      }),
    });
    expect(Object.keys(queued.queuedMessages ?? {})).toEqual(["q1"]);
    const changed = chatReducer(queued, {
      type: "event",
      event: event("session.inbox.delivery.changed", { inboxID: "q1", delivery: "steer" }),
    });
    expect(Object.keys(changed.queuedMessages ?? {})).toEqual([]);
    expect(changed.queuedTurnIds ?? []).toEqual([]);
  });
});

describe("background result details", () => {
  it("keeps the full output behind a details expander", () => {
    const parsed = parseBackgroundResult(
      '<background-result kind="shell" id="s1" state="completed" command="check">line one\nline two</background-result>',
    );
    expect(parsed).toBeDefined();
    const note = backgroundNotice("n1", 1, parsed!);
    expect(note.text).toBe("line two");
    expect(note.detail).toBe("line one\nline two");
  });
});
