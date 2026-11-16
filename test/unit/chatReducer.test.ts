import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerEvent, SessionMessage } from "../../src/shared/api";
import {
  chatReducer,
  initialChatState,
  orphanPermissions,
  permissionsForTool,
  selectTodos,
  type ChatState,
  type UiAssistantMessage,
} from "../../src/shared/chatReducer";

function fixture(name: string): ServerEvent[] {
  return readFileSync(join(__dirname, "../fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ServerEvent);
}

function open(sessionId: string, messages: SessionMessage[] = []): ChatState {
  return chatReducer(initialChatState, { type: "load", sessionId, messages, permissions: [], forms: [] });
}

const S1 = "ses_e1a6de108ffeUoLnIxsC0Iz3qR";
const S2 = "ses_e1a6c6a18ffeykSYEWYa5gpP3I";
const S3 = "ses_e1a69c3cbffe81j4RaR5lg6YJH";

function assistants(state: ChatState): UiAssistantMessage[] {
  return state.messages.filter((m): m is UiAssistantMessage => m.kind === "assistant");
}

describe("chatReducer with recorded opencode 2.2.7 streams", () => {
  it("folds a simple reply: reasoning + text, busy flag, usage, title", () => {
    const events = fixture("real-sse1.jsonl");
    // Stop after the first execution finished.
    const end = events.findIndex((e) => e.type === "session.renamed");
    const state = chatReducer(open(S1), { type: "events", events: events.slice(0, end + 1) });
    expect(state.busy).toBe(false);
    expect(state.title).toBe("Hello world reply");
    const user = state.messages[0];
    expect(user.kind === "user" && user.text).toBe("Reply with exactly: hello world. Do not use tools.");
    const [a] = assistants(state);
    expect(a.done).toBe(true);
    expect(a.parts.map((p) => p.kind)).toEqual(["reasoning", "text"]);
    expect(a.parts[1].kind === "text" && a.parts[1].text).toBe("hello world");
    expect(state.usage?.tokens.output).toBeGreaterThan(0);
  });

  it("is busy while streaming and collects deltas incrementally", () => {
    const events = fixture("real-sse1.jsonl");
    const firstDelta = events.findIndex((e) => e.type === "session.text.delta");
    const state = chatReducer(open(S1), { type: "events", events: events.slice(0, firstDelta + 1) });
    expect(state.busy).toBe(true);
    const [a] = assistants(state);
    expect(a.done).toBe(false);
    const text = a.parts.find((p) => p.kind === "text");
    expect(text && text.kind === "text" && text.text).toBe("hello world");
  });

  it("renders generic tool calls (write, shell) with input and output", () => {
    const events = fixture("real-sse2.jsonl");
    const state = chatReducer(open(S1), { type: "events", events });
    const tools = assistants(state).flatMap((a) => a.parts).filter((p) => p.kind === "tool");
    expect(tools.map((t) => t.kind === "tool" && t.name)).toEqual(["write", "shell", "shell"]);
    for (const t of tools) {
      if (t.kind !== "tool") continue;
      expect(t.status).toBe("completed");
      expect(t.input).toBeDefined();
      expect(t.output[0]).toMatchObject({ type: "text" });
    }
  });

  it("attaches a permission request to its tool card and removes it on reply", () => {
    const events = fixture("real-sse3.jsonl");
    const asked = events.findIndex((e) => e.type === "permission.asked");
    let state = chatReducer(open(S2), { type: "events", events: events.slice(0, asked + 1) });
    expect(state.permissions).toHaveLength(1);
    const toolId = (events[asked].data as { source: { id: string } }).source.id;
    expect(permissionsForTool(state, toolId)).toHaveLength(1);
    expect(orphanPermissions(state)).toHaveLength(0);
    state = chatReducer(state, { type: "events", events: events.slice(asked + 1) });
    expect(state.permissions).toHaveLength(0);
    const edit = assistants(state).flatMap((a) => a.parts).find((p) => p.kind === "tool" && p.name === "edit");
    expect(edit && edit.kind === "tool" && edit.status).toBe("completed");
    expect(edit && edit.kind === "tool" && (edit.metadata?.files as unknown[]).length).toBe(1);
  });

  it("tracks question forms", () => {
    const events = fixture("real-sse4.jsonl");
    const created = events.findIndex((e) => e.type === "form.created");
    let state = chatReducer(open(S2), { type: "events", events: events.slice(0, created + 1) });
    expect(state.forms).toHaveLength(1);
    expect(state.forms[0].fields[0].options?.map((o) => o.value)).toEqual(["Red", "Green", "Blue"]);
    state = chatReducer(state, { type: "events", events: events.slice(created + 1) });
    expect(state.forms).toHaveLength(0);
  });

  it("marks interrupted executions and stops being busy", () => {
    const events = fixture("real-sse5.jsonl");
    const state = chatReducer(open(S2), { type: "events", events });
    expect(state.busy).toBe(false);
    const last = state.messages[state.messages.length - 1];
    expect(last).toMatchObject({ kind: "notice", code: "interrupted" });
    expect(assistants(state).every((a) => a.done)).toBe(true);
  });

  it("derives the todo list from todowrite", () => {
    const state = chatReducer(open(S3), { type: "events", events: fixture("real-sse6.jsonl") });
    expect(selectTodos(state)).toEqual([
      { content: "First task (in progress)", status: "in_progress" },
      { content: "Second task", status: "pending" },
      { content: "Third task", status: "pending" },
    ]);
  });

  it("ignores events from other sessions", () => {
    const state = chatReducer(open("ses_other"), { type: "events", events: fixture("real-sse1.jsonl") });
    expect(state.messages).toHaveLength(0);
  });
});

describe("chatReducer history loading", () => {
  const history: SessionMessage[] = [
    { id: "msg_3", type: "idle", outcome: "succeeded", time: { created: 3 } },
    {
      id: "msg_2",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2, completed: 3 },
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "tool", id: "t1", name: "read", state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "a" }] } },
        { type: "text", text: "done" },
      ],
    },
    { id: "msg_1", type: "user", text: "hi", time: { created: 1 } },
  ];

  it("sorts messages chronologically and maps parts", () => {
    const state = open("s", history);
    expect(state.messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
    const a = state.messages[1] as UiAssistantMessage;
    expect(a.parts.map((p) => p.key)).toEqual(["reasoning:0", "tool:t1", "text:0"]);
    expect(state.busy).toBe(false);
  });

  it("continues streaming into a message loaded from history (resync after reconnect)", () => {
    const partial: SessionMessage[] = [
      { id: "msg_1", type: "user", text: "hi", time: { created: 1 } },
      { id: "msg_2", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2 }, content: [{ type: "text", text: "hel" }] },
    ];
    let state = open("s", partial);
    expect(state.busy).toBe(true);
    state = chatReducer(state, {
      type: "event",
      event: { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "msg_2", ordinal: 0, delta: "lo" } },
    });
    const a = state.messages[1] as UiAssistantMessage;
    expect(a.parts).toHaveLength(1);
    expect(a.parts[0].kind === "text" && a.parts[0].text).toBe("hello");
  });

  it("shows failed executions with the server error message", () => {
    let state = open("s");
    state = chatReducer(state, { type: "event", event: { type: "session.execution.started", data: { sessionID: "s" } } });
    state = chatReducer(state, {
      type: "event",
      event: { id: "e1", type: "session.execution.failed", data: { sessionID: "s", error: { type: "auth", message: "No API key" } } },
    });
    expect(state.busy).toBe(false);
    expect(state.lastError?.message).toBe("No API key");
    expect(state.messages.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "No API key" });
  });

  it("does not duplicate user messages delivered twice", () => {
    let state = open("s", [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }]);
    state = chatReducer(state, {
      type: "event",
      event: { type: "session.inbox.enqueued", data: { sessionID: "s", inboxID: "msg_1", item: { type: "user", payload: { text: "hi" } } } },
    });
    expect(state.messages).toHaveLength(1);
  });
});
