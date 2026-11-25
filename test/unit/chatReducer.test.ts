import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, FileDiff, ServerEvent, SessionInfo, SessionMessage } from "../../src/shared/api";
import {
  chatReducer,
  initialChatState,
  mergeChangedFiles,
  orphanPermissions,
  permissionsForTool,
  selectToolChangedFiles,
  selectTodos,
  selectTurnFileChanges,
  sessionIsBusy,
  sessionTimeline,
  sessionLooksBusy,
  sessionTurnStatus,
  toSessionSummary,
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

describe("linkSubagent", () => {
  const runningSubagent = (id: string, description: string): SessionMessage => ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: `tool-${id}`,
        name: "subagent",
        // Matches real persisted state of a running child: no metadata.sessionID yet.
        state: { status: "running", input: { description }, metadata: {} },
      },
    ],
  });

  it("links a discovered child to the matching card, or the newest unlinked one", () => {
    const state = open(S1, [runningSubagent("m1", "first"), runningSubagent("m2", "second")]);
    const linked = chatReducer(state, { type: "linkSubagent", sessionId: "child-2", title: "second" });
    const ids = assistants(linked)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids).toEqual([undefined, "child-2"]);

    const fallback = chatReducer(state, { type: "linkSubagent", sessionId: "child-2" });
    const fallbackIds = assistants(fallback)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(fallbackIds).toEqual([undefined, "child-2"]);
  });

  it("links by tool id, even when two children share a description", () => {
    const state = open(S1, [runningSubagent("m1", "same job"), runningSubagent("m2", "same job")]);
    const linked = chatReducer(state, { type: "linkSubagent", toolId: "tool-m2", sessionId: "child-2" });
    const ids = assistants(linked)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids).toEqual([undefined, "child-2"]);
  });

  it("remembers an explicit link until the tool card is rendered", () => {
    const pending = chatReducer(open(S1), { type: "linkSubagent", toolId: "tool-m1", sessionId: "child-1" });
    const base = { sessionID: S1, assistantMessageID: "m1", id: "tool-m1" };
    const events: ServerEvent[] = [
      { type: "session.tool.input.started", created: 1, data: { ...base, name: "subagent" } },
      { type: "session.tool.called", created: 2, data: { ...base, input: { description: "same job" } } },
    ];
    const withCard = events.reduce((state, event) => chatReducer(state, { type: "event", event }), pending);
    const ids = assistants(withCard)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids).toEqual(["child-1"]);
  });

  it("does not overwrite an id that is already known", () => {
    const state = open(S1, [runningSubagent("m1", "first")]);
    const linked = chatReducer(state, { type: "linkSubagent", sessionId: "child-1", title: "first" });
    const again = chatReducer(linked, { type: "linkSubagent", sessionId: "child-2", title: "first" });
    const ids = assistants(again)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids).toEqual(["child-1"]);
  });

  it("survives a tail resync replacing the live card with its history version", () => {
    const messages = [runningSubagent("m1", "first")];
    const linked = chatReducer(open(S1, messages), { type: "linkSubagent", sessionId: "child-1", title: "first" });
    const resynced = chatReducer(linked, { type: "append", delta: { sessionId: S1, messages, permissions: [], forms: [] } });
    const ids = assistants(resynced)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids).toEqual(["child-1"]);
  });

  it("survives a same-session history reload but not a switch to another session", () => {
    const messages = [runningSubagent("m1", "first")];
    const linked = chatReducer(open(S1, messages), { type: "linkSubagent", sessionId: "child-1", title: "first" });
    const reload = (sessionId: string) => chatReducer(linked, { type: "load", sessionId, messages, permissions: [], forms: [] });
    const ids = (state: ChatState) =>
      assistants(state)
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.kind === "tool" ? [p.metadata?.sessionID] : []));
    expect(ids(reload(S1))).toEqual(["child-1"]);
    expect(ids(reload(S2))).toEqual([undefined]);
  });
});

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
    const tools = assistants(state)
      .flatMap((a) => a.parts)
      .filter((p) => p.kind === "tool");
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
    const edit = assistants(state)
      .flatMap((a) => a.parts)
      .find((p) => p.kind === "tool" && p.name === "edit");
    expect(edit && edit.kind === "tool" && edit.status).toBe("completed");
    expect(edit && edit.kind === "tool" && edit.metadata && (edit.metadata.files as unknown[]).length).toBe(1);
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

  it("unlocks the composer when a question form is cancelled", () => {
    const form = { id: "frm_1", sessionID: S2, title: "Questions", fields: [] };
    let state = chatReducer(open(S2), {
      type: "events",
      events: [
        {
          type: "session.inbox.enqueued",
          created: 100,
          data: { sessionID: S2, inboxID: "u1", item: { type: "user", payload: { text: "hi" } } },
        },
        { type: "session.execution.started", data: { sessionID: S2 } },
        { type: "form.created", data: { sessionID: S2, form } },
      ],
    });
    expect(state.busy).toBe(true);
    expect(state.forms).toHaveLength(1);
    expect(state.turns.at(-1)?.ended).toBeUndefined();
    state = chatReducer(state, {
      type: "event",
      event: { type: "form.cancelled", created: 200, data: { sessionID: S2, id: form.id } },
    });
    expect(state.forms).toHaveLength(0);
    expect(state.busy).toBe(false);
    expect(state.turns.at(-1)?.ended).toBe(200);
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

  it("batched deltas produce exactly the same state as applying them one by one", () => {
    // Delta coalescing is an optimisation: it must never change the resulting conversation.
    for (const name of ["real-sse1.jsonl", "real-sse2.jsonl", "real-sse3.jsonl", "real-sse4.jsonl", "real-sse5.jsonl", "real-sse6.jsonl"]) {
      const events = fixture(name);
      const batched = chatReducer(open(S1), { type: "events", events });
      const sequential = events.reduce((s, event) => chatReducer(s, { type: "event", event }), open(S1));
      expect(batched, name).toEqual(sequential);
    }
  });

  it("coalesces adjacent deltas but never merges across a different event", () => {
    // Two deltas for the same part around a delta for another part: each must stay in place.
    const state = chatReducer(open("s"), {
      type: "events",
      events: [
        { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "a1", ordinal: 0, delta: "a" } },
        { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "a1", ordinal: 1, delta: "X" } },
        { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "a1", ordinal: 0, delta: "b" } },
      ],
    });
    const parts = assistants(state)[0].parts;
    expect(parts.map((p) => (p.kind === "text" ? p.text : ""))).toEqual(["ab", "X"]);
  });
});

describe("malformed live events degrade gracefully", () => {
  it("ignores usage events without token counts instead of erasing usage", () => {
    const usage = { cost: 0.5, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } };
    const state = chatReducer(
      { ...open("s"), usage },
      {
        type: "event",
        event: { type: "session.usage.updated", data: { sessionID: "s", cost: 0.9 } },
      },
    );
    expect(state.usage).toEqual(usage);
  });

  it("keeps the selected model when a model-selected event is malformed", () => {
    const model = { id: "m", providerID: "p" };
    const state = chatReducer(
      { ...open("s"), model },
      {
        type: "event",
        event: { type: "session.model.selected", data: { sessionID: "s" } },
      },
    );
    expect(state.model).toEqual(model);
  });

  it("keeps the assistant's model when a step-started event carries a malformed model", () => {
    const model = { id: "m", providerID: "p" };
    const base = chatReducer(open("s"), {
      type: "event",
      event: { type: "session.step.started", data: { sessionID: "s", assistantMessageID: "a1", agent: "build", model } },
    });
    const state = chatReducer(base, {
      type: "event",
      event: { type: "session.step.started", data: { sessionID: "s", assistantMessageID: "a1", model: { id: 123 } } },
    });
    expect(assistants(state)[0]?.model).toEqual(model);
  });

  it("ignores assistant part events without a message id", () => {
    const state = chatReducer(open("s"), {
      type: "event",
      event: { type: "session.text.delta", data: { sessionID: "s", ordinal: 0, delta: "ghost" } },
    });
    expect(assistants(state)).toHaveLength(0);
  });

  it("drops malformed permission and form cards without throwing", () => {
    let state = chatReducer(open("s"), {
      type: "events",
      events: [
        { type: "permission.asked", data: { sessionID: "s", id: "p1" } },
        { type: "form.created", data: { sessionID: "s", form: { id: "f1", sessionID: "s", fields: [] } } },
      ],
    });
    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0].resources).toEqual([]);
    expect(state.forms).toHaveLength(1);
    // A card with no id is unusable: it is dropped instead of crashing the renderer.
    state = chatReducer(state, {
      type: "events",
      events: [
        { type: "permission.asked", data: { sessionID: "s" } },
        { type: "form.created", data: { sessionID: "s" } },
      ],
    });
    expect(state.permissions).toHaveLength(1);
    expect(state.forms).toHaveLength(1);
  });
});

describe("turn metrics", () => {
  const first = { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 0 } };
  const second = { input: 50, output: 10, reasoning: 0, cache: { read: 100, write: 20 } };
  const total = { input: 150, output: 30, reasoning: 5, cache: { read: 300, write: 20 } };

  it("sums every step from the user input to the end of the execution", () => {
    let state = chatReducer(open(S1), {
      type: "events",
      events: [
        {
          type: "session.inbox.enqueued",
          created: 1000,
          data: { sessionID: S1, inboxID: "msg_u1", item: { type: "user", payload: { text: "hi" } } },
        },
        { type: "session.execution.started", created: 1010, data: { sessionID: S1 } },
        { type: "session.step.started", created: 1100, data: { sessionID: S1, assistantMessageID: "m1", agent: "build" } },
        {
          type: "session.step.ended",
          created: 3000,
          data: { sessionID: S1, assistantMessageID: "m1", finish: "tool-use", cost: 0.001, tokens: first },
        },
        { type: "session.step.started", created: 3100, data: { sessionID: S1, assistantMessageID: "m2", agent: "build" } },
        {
          type: "session.step.ended",
          created: 6000,
          data: { sessionID: S1, assistantMessageID: "m2", finish: "stop", cost: 0.002, tokens: second },
        },
      ],
    });
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].ended).toBeUndefined();

    state = chatReducer(state, {
      type: "event",
      event: { type: "session.execution.succeeded", created: 6500, data: { sessionID: S1 } },
    });
    const [turn] = state.turns;
    expect(turn).toMatchObject({ id: "msg_u1", started: 1000, ended: 6500 });
    expect(turn.tokens).toEqual(total);
    expect(turn.cost).toBeCloseTo(0.003);
  });

  it("opens a turn on a busy status seen mid-turn, so step tokens are kept", () => {
    const state = chatReducer(open(S1), {
      type: "events",
      events: [
        { type: "session.status", created: 1000, data: { sessionID: S1, status: { type: "busy" } } },
        { type: "session.step.started", created: 1100, data: { sessionID: S1, assistantMessageID: "m1" } },
        { type: "session.step.ended", created: 2000, data: { sessionID: S1, assistantMessageID: "m1", tokens: first, cost: 0.001 } },
        { type: "session.execution.succeeded", created: 2100, data: { sessionID: S1 } },
      ],
    });
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ started: 1000, ended: 2100 });
    expect(state.turns[0].tokens).toEqual(first);
  });

  it("rebuilds one total per turn from history", () => {
    const assistant = (id: string, created: number, tokens: typeof first, cost: number): SessionMessage => ({
      id,
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created, completed: created + 200 },
      tokens,
      cost,
      content: [{ type: "text", text: "ok" }],
    });
    const state = open("s", [
      { id: "u1", type: "user", text: "hi", time: { created: 1000 } },
      assistant("m1", 1100, first, 0.001),
      assistant("m2", 1400, second, 0.002),
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2000 } },
      { id: "u2", type: "user", text: "again", time: { created: 3000 } },
      assistant("m3", 3100, first, 0.003),
      { id: "i2", type: "idle", outcome: "succeeded", time: { created: 4000 } },
      // The last turn has no idle entry yet; use the assistant completion time as its end.
      { id: "u3", type: "user", text: "third", time: { created: 5000 } },
      assistant("m4", 5100, first, 0.004),
    ]);
    expect(state.turns).toHaveLength(3);
    expect(state.turns[0]).toMatchObject({ id: "u1", started: 1000, ended: 2000 });
    expect(state.turns[0].tokens).toEqual(total);
    expect(state.turns[0].cost).toBeCloseTo(0.003);
    expect(state.turns[1]).toMatchObject({ id: "u2", started: 3000, ended: 4000, cost: 0.003 });
    expect(state.turns[2]).toMatchObject({ id: "u3", started: 5000, ended: 5300 });
  });

  it("keeps the first model of each turn from history", () => {
    const assistant = (id: string, created: number, model: { id: string; providerID: string }): SessionMessage => ({
      id,
      type: "assistant",
      agent: "build",
      model,
      time: { created, completed: created + 200 },
      tokens: first,
      content: [{ type: "text", text: "ok" }],
    });
    const state = open("s", [
      { id: "u1", type: "user", text: "hi", time: { created: 1000 } },
      assistant("m1", 1100, { id: "fast", providerID: "acme" }),
      assistant("m2", 1400, { id: "slow", providerID: "acme" }),
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2000 } },
      { id: "u2", type: "user", text: "again", time: { created: 3000 } },
      assistant("m3", 3100, { id: "other", providerID: "vendor" }),
      { id: "i2", type: "idle", outcome: "succeeded", time: { created: 4000 } },
    ]);
    expect(state.turns[0].model).toEqual({ id: "fast", providerID: "acme" });
    expect(state.turns[1].model).toEqual({ id: "other", providerID: "vendor" });
  });

  it("captures the first step's model live and keeps it across a resync", () => {
    const events: ServerEvent[] = [
      {
        type: "session.inbox.enqueued",
        created: 1000,
        data: { sessionID: S1, inboxID: "u1", item: { type: "user", payload: { text: "hi" } } },
      },
      {
        type: "session.step.started",
        created: 1100,
        data: { sessionID: S1, assistantMessageID: "m1", model: { id: "fast", providerID: "acme" } },
      },
      { type: "session.step.ended", created: 1200, data: { sessionID: S1, assistantMessageID: "m1", tokens: first } },
      {
        type: "session.step.started",
        created: 1300,
        data: { sessionID: S1, assistantMessageID: "m2", model: { id: "slow", providerID: "acme" } },
      },
      { type: "session.step.ended", created: 1400, data: { sessionID: S1, assistantMessageID: "m2", tokens: second } },
    ];
    const live = chatReducer(open(S1), { type: "events", events });
    expect(live.turns[0].model).toEqual({ id: "fast", providerID: "acme" });

    // The tail only sees the later step; rebuilding must not overwrite the first model.
    const messages: SessionMessage[] = [
      { id: "u1", type: "user", text: "hi", time: { created: 1000 } },
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: { id: "slow", providerID: "acme" },
        time: { created: 1300, completed: 1400 },
        tokens: second,
        content: [{ type: "text", text: "two" }],
      },
    ];
    const resynced = chatReducer(live, { type: "append", delta: { sessionId: S1, messages, permissions: [], forms: [] } });
    expect(resynced.turns.find((t) => t.id === "u1")?.model).toEqual({ id: "fast", providerID: "acme" });
  });

  it("emits exactly one summary per execution in a real recorded stream", () => {
    const events = fixture("real-sse1.jsonl");
    const state = chatReducer(open(S1), { type: "events", events });
    // The fixture interleaves two sessions; only S1 belongs to the open chat.
    const executions = events.filter(
      (e) => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type) && (e.data as { sessionID?: string }).sessionID === S1,
    );
    const firstInput = events.find((e) => e.type === "session.inbox.enqueued" && (e.data as { sessionID?: string }).sessionID === S1);
    expect(state.turns).toHaveLength(executions.length);
    expect(state.turns[0].started).toBe(firstInput?.created);
    expect(state.turns[0].ended).toBe(executions[0].created);
    // The multi-step turn must add up all its steps, not only the last one.
    let best = { count: 0, turn: state.turns[0], sum: 0 };
    for (const t of state.turns) {
      const steps = events.filter(
        (e) => e.type === "session.step.ended" && (e.created ?? 0) > t.started && (e.created ?? 0) <= (t.ended ?? 0),
      );
      const sum = steps.reduce((acc, e) => {
        const tk = (e.data as { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } })
          .tokens;
        return acc + (tk ? tk.input + tk.output + tk.reasoning + tk.cache.read + tk.cache.write : 0);
      }, 0);
      if (steps.length > best.count) best = { count: steps.length, turn: t, sum };
    }
    expect(best.count).toBeGreaterThan(1);
    const tk = best.turn.tokens!;
    expect(tk.input + tk.output + tk.reasoning + tk.cache.read + tk.cache.write).toBe(best.sum);
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
        {
          type: "tool",
          id: "t1",
          name: "read",
          state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "a" }] },
        },
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
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p" },
        time: { created: 2 },
        content: [{ type: "text", text: "hel" }],
      },
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
      event: {
        type: "session.inbox.enqueued",
        data: { sessionID: "s", inboxID: "msg_1", item: { type: "user", payload: { text: "hi" } } },
      },
    });
    expect(state.messages).toHaveLength(1);
  });

  it("maps live user attachments from source.uri like history", () => {
    let state = open("s");
    state = chatReducer(state, {
      type: "event",
      event: {
        type: "session.inbox.enqueued",
        data: {
          sessionID: "s",
          inboxID: "msg_1",
          item: {
            type: "user",
            payload: {
              text: "What is in this file?",
              files: [{ data: "YQo=", mime: "text/plain", source: { type: "uri", uri: "file:///work/a.txt" }, name: "a.txt" }],
            },
          },
        },
      },
    });
    expect(state.messages).toHaveLength(1);
    const user = state.messages[0];
    expect(user.kind === "user" && user.files).toEqual([{ uri: "file:///work/a.txt", name: "a.txt" }]);
  });
});

describe("busy state after an interrupt", () => {
  const now = 1_795_004_012_704;
  const time = { created: now - 500, updated: now, busy: now, idle: now - 105 };

  // An interrupted session observed on a real 2.2.7 server: `busy` ended up newer than
  // `idle`, so a plain timestamp comparison leaves the composer stuck on "stop".
  const interruptedHistory: SessionMessage[] = [
    { id: "msg_1", type: "user", text: "Tell me a story", time: { created: now - 400 } },
    {
      id: "msg_2",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: now - 390, completed: now - 105 },
      content: [],
    },
    { id: "msg_3", type: "idle", outcome: "interrupted", time: { created: now - 105 } },
  ];

  it("a terminal idle message wins over stale busy/idle timestamps", () => {
    expect(sessionIsBusy(time, interruptedHistory)).toBe(false);
  });

  it("trusts the timestamps when no terminal message is present", () => {
    expect(sessionIsBusy(time, interruptedHistory.slice(0, 2))).toBe(true);
    expect(sessionIsBusy({ ...time, idle: now + 1 }, interruptedHistory.slice(0, 2))).toBe(false);
  });

  it("ignores trailing bookkeeping messages after the terminal idle", () => {
    const withCompaction: SessionMessage[] = [...interruptedHistory, { id: "msg_4", type: "compaction", time: { created: now - 100 } }];
    expect(sessionIsBusy(time, withCompaction)).toBe(false);
  });

  it("gives the session list the same answer as the open chat", () => {
    const info: SessionInfo = {
      id: "s",
      projectID: "p",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time,
      title: "Chat",
      location: { directory: "/work" },
    };
    expect(toSessionSummary(info, interruptedHistory)).toMatchObject({
      id: "s",
      title: "Chat",
      updated: now,
      busy: false,
      needsInput: false,
    });
    expect(toSessionSummary(info, interruptedHistory.slice(0, 2)).busy).toBe(true);
    // Without a history the list can only use the timestamps, as before.
    expect(toSessionSummary(info).busy).toBe(true);
    expect(toSessionSummary(info, undefined, true).needsInput).toBe(true);
  });

  it("does not let a stale host busy flag re-lock the composer on load", () => {
    const state = chatReducer(initialChatState, {
      type: "load",
      sessionId: "s",
      busy: true, // from the server's (stale) time.busy > time.idle comparison
      messages: interruptedHistory,
      permissions: [],
      forms: [],
    });
    expect(state.busy).toBe(false);
  });

  // Real 2.4.0 session interrupted by a location shutdown: no `idle` message was written at all,
  // the last assistant message is completed with an `aborted` error, and `time.busy` stays set
  // with no `time.idle` — so the timestamp-only check reports the session as running forever.
  const abortedTime = { created: now - 5000, updated: now, busy: now - 5000 };
  const abortedUser: SessionMessage = {
    id: "msg_a",
    type: "user",
    text: "Miglioramenti per l'estensione",
    time: { created: now - 5000 },
  };
  const abortedAssistant: AssistantMessage = {
    id: "msg_b",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: now - 4900, completed: now },
    content: [],
    error: { type: "aborted", message: "Step interrupted" },
  };
  const abortedWithoutIdle: SessionMessage[] = [abortedUser, abortedAssistant];

  it("treats a completed aborted assistant message with no idle marker as terminal", () => {
    expect(sessionLooksBusy(abortedTime)).toBe(true);
    expect(sessionIsBusy(abortedTime, abortedWithoutIdle)).toBe(false);
  });

  it("ignores trailing bookkeeping after the aborted assistant message", () => {
    const withCompaction: SessionMessage[] = [...abortedWithoutIdle, { id: "msg_c", type: "compaction", time: { created: now + 1 } }];
    expect(sessionIsBusy(abortedTime, withCompaction)).toBe(false);
  });

  it("does not treat other errors or an unfinished aborted step as terminal", () => {
    const failed: SessionMessage[] = [{ ...abortedUser }, { ...abortedAssistant, error: { type: "provider", message: "rate limited" } }];
    expect(sessionIsBusy(abortedTime, failed)).toBe(true);
    const unfinished: SessionMessage[] = [{ ...abortedUser }, { ...abortedAssistant, time: { created: now - 4900 } }];
    expect(sessionIsBusy(abortedTime, unfinished)).toBe(true);
  });

  it("still marks a new prompt after the abort as busy", () => {
    const followedByPrompt: SessionMessage[] = [
      ...abortedWithoutIdle,
      { id: "msg_c", type: "user", text: "Riprendi", time: { created: now + 1 } },
    ];
    expect(sessionIsBusy({ ...abortedTime, busy: now + 1, updated: now + 1 }, followedByPrompt)).toBe(true);
  });

  it("gives the session list and the open chat the same answer for the real interrupted shape", () => {
    const info: SessionInfo = {
      id: "s",
      projectID: "p",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: abortedTime,
      title: "Miglioramenti per l'estensione",
      location: { directory: "/work" },
    };
    expect(toSessionSummary(info, abortedWithoutIdle).busy).toBe(false);
    const state = chatReducer(initialChatState, {
      type: "load",
      sessionId: "s",
      busy: true, // stale host flag
      messages: abortedWithoutIdle,
      permissions: [],
      forms: [],
    });
    expect(state.busy).toBe(false);
  });
});

describe("session list error indicator", () => {
  const now = 1_795_004_012_704;
  const info = (time: SessionInfo["time"] = { created: now - 500, updated: now, busy: now - 500 }): SessionInfo => ({
    id: "s",
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time,
    title: "Chat",
    location: { directory: "/work" },
  });
  const user: SessionMessage = { id: "u1", type: "user", text: "Hello", time: { created: now - 500 } };
  const assistant = (error?: { type: string; message: string }): SessionMessage => ({
    id: "a1",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: now - 400, completed: now },
    content: [],
    error,
  });

  it("uses the idle outcome for failed and interrupted turns", () => {
    expect(toSessionSummary(info(), [user, { id: "i1", type: "idle", outcome: "failed", time: { created: now } }]).error).toBe("failed");
    expect(toSessionSummary(info(), [user, { id: "i1", type: "idle", outcome: "interrupted", time: { created: now } }]).error).toBe(
      "interrupted",
    );
    expect(
      toSessionSummary(info(), [user, { id: "i1", type: "idle", outcome: "succeeded", time: { created: now } }]).error,
    ).toBeUndefined();
  });

  it("recognizes an aborted assistant with no idle marker, even with stale busy timestamps", () => {
    const summary = toSessionSummary(info({ created: now - 500, updated: now, busy: now }), [
      user,
      assistant({ type: "aborted", message: "Step interrupted" }),
    ]);
    expect(summary.busy).toBe(false);
    expect(summary.error).toBe("interrupted");
  });

  it("recognizes a generic error on the last completed assistant message", () => {
    expect(toSessionSummary(info(), [user, assistant({ type: "provider", message: "rate limited" })]).error).toBe("failed");
  });

  it("ignores an older error once a new prompt started the next turn", () => {
    const summary = toSessionSummary(info({ created: now - 500, updated: now + 10, busy: now + 10 }), [
      user,
      assistant({ type: "provider", message: "rate limited" }),
      { id: "u2", type: "user", text: "Retry", time: { created: now + 10 } },
    ]);
    expect(summary.busy).toBe(true);
    expect(summary.error).toBeUndefined();
  });

  it("ignores trailing bookkeeping messages after the terminal one", () => {
    const summary = toSessionSummary(info(), [
      user,
      { id: "i1", type: "idle", outcome: "failed", time: { created: now } },
      { id: "c1", type: "compaction", time: { created: now + 1 } },
    ]);
    expect(summary.error).toBe("failed");
  });

  it("leaves running and successful sessions without an error", () => {
    expect(toSessionSummary(info(), [user, { ...assistant(), time: { created: now - 400 } }]).error).toBeUndefined();
    expect(toSessionSummary(info(), [user, assistant()]).error).toBeUndefined();
  });

  it("falls back to the timestamps when the history is unavailable", () => {
    expect(sessionTurnStatus(info().time)).toBe("running");
    expect(sessionTurnStatus({ ...info().time, idle: now + 1 })).toBe("idle");
    expect(toSessionSummary(info()).error).toBeUndefined();
  });
});

describe("a prompt queued while a turn is running", () => {
  const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };

  function running(): ChatState {
    return chatReducer(open(S1), {
      type: "events",
      events: [
        {
          type: "session.inbox.enqueued",
          created: 1000,
          data: { sessionID: S1, inboxID: "u1", item: { type: "user", payload: { text: "first" } } },
        },
        { type: "session.execution.started", created: 1010, data: { sessionID: S1 } },
        { type: "session.step.started", created: 1100, data: { sessionID: S1, assistantMessageID: "m1", agent: "build" } },
        {
          type: "session.step.ended",
          created: 1200,
          data: { sessionID: S1, assistantMessageID: "m1", finish: "tool-calls", cost: 0.001, tokens },
        },
      ],
    });
  }

  it("does not close the running turn just because the next prompt was enqueued", () => {
    const state = chatReducer(running(), {
      type: "event",
      event: {
        type: "session.inbox.enqueued",
        created: 1300,
        data: { sessionID: S1, inboxID: "u2", item: { type: "user", payload: { text: "next" }, delivery: "queue" } },
      },
    });
    expect(state.busy).toBe(true);
    // A queued prompt is not sent yet: it stays in the inbox panel, not in the conversation.
    expect(state.messages.filter((m) => m.kind === "user")).toHaveLength(1);
    expect(state.queuedMessages?.u2).toMatchObject({ id: "u2", text: "next" });
    // The running turn stays open: no premature summary, and no second turn until it really starts.
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].ended).toBeUndefined();

    // Once the server hands the prompt to the agent, it joins the conversation.
    const delivered = chatReducer(state, {
      type: "event",
      event: { type: "session.inbox.delivered", created: 1500, data: { sessionID: S1, inboxID: "u2" } },
    });
    expect(delivered.messages.filter((m) => m.kind === "user")).toHaveLength(2);
    expect(delivered.queuedMessages?.u2).toBeUndefined();
    expect(delivered.turns).toHaveLength(1);

    const started = chatReducer(state, {
      type: "event",
      event: { type: "session.execution.started", created: 2000, data: { sessionID: S1 } },
    });
    expect(started.messages.filter((m) => m.kind === "user")).toHaveLength(2);
    expect(started.queuedMessages?.u2).toBeUndefined();
    expect(started.turns).toHaveLength(2);
    expect(started.turns[0]).toMatchObject({ id: "u1", ended: 2000 });
    expect(started.turns[1]).toMatchObject({ id: "u2", started: 2000 });
  });

  it("reconciles queued prompts with the authoritative inbox list after a resync", () => {
    const queued = chatReducer(running(), {
      type: "event",
      event: {
        type: "session.inbox.enqueued",
        created: 1300,
        data: { sessionID: S1, inboxID: "u2", item: { type: "user", payload: { text: "next" }, delivery: "queue" } },
      },
    });
    expect(queued.queuedTurnIds).toEqual(["u2"]);

    // The server does not have the item: its delivered/cancelled event was lost in a reconnect.
    const synced = chatReducer(queued, { type: "inbox", items: [] });
    expect(synced.queuedMessages?.u2).toBeUndefined();
    expect(synced.queuedTurnIds).toEqual([]);
    expect(synced.messages.filter((m) => m.kind === "user")).toHaveLength(1);
    const late = chatReducer(synced, {
      type: "event",
      event: { type: "session.execution.started", created: 2000, data: { sessionID: S1 } },
    });
    expect(late.messages.filter((m) => m.kind === "user")).toHaveLength(1);

    // An item still present in the inbox stays queued.
    const kept = chatReducer(queued, {
      type: "inbox",
      items: [{ id: "u2", sessionID: S1, time: { created: 1300 }, type: "user", delivery: "queue", payload: { text: "next" } }],
    });
    expect(kept.queuedTurnIds).toEqual(["u2"]);
  });

  it("keeps a cancelled queued prompt out of the conversation", () => {
    const queued = chatReducer(running(), {
      type: "event",
      event: {
        type: "session.inbox.enqueued",
        created: 1300,
        data: { sessionID: S1, inboxID: "u2", item: { type: "user", payload: { text: "next" }, delivery: "queue" } },
      },
    });
    const cancelled = chatReducer(queued, {
      type: "event",
      event: { type: "session.inbox.cancelled", created: 1400, data: { sessionID: S1, inboxID: "u2" } },
    });
    expect(cancelled.messages.filter((m) => m.kind === "user")).toHaveLength(1);
    expect(cancelled.queuedMessages?.u2).toBeUndefined();
    expect(cancelled.queuedTurnIds).toEqual([]);

    // A late delivery for a removed item must not resurrect it.
    const late = chatReducer(cancelled, {
      type: "event",
      event: { type: "session.inbox.delivered", created: 1500, data: { sessionID: S1, inboxID: "u2" } },
    });
    expect(late.messages.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("starts each queued prompt in order with its own turn id", () => {
    let state = running();
    for (const [id, text, created] of [
      ["u2", "second", 1300],
      ["u3", "third", 1350],
    ] as const) {
      state = chatReducer(state, {
        type: "event",
        event: {
          type: "session.inbox.enqueued",
          created,
          data: { sessionID: S1, inboxID: id, item: { type: "user", payload: { text }, delivery: "queue" } },
        },
      });
    }
    expect(state.queuedTurnIds).toEqual(["u2", "u3"]);
    expect(state.messages.filter((m) => m.kind === "user")).toHaveLength(1);

    // No `inbox.delivered` events at all (e.g. missed on a reconnect): `execution.started` must
    // still deliver each prompt and open its turn under the real user message id.
    const second = chatReducer(state, {
      type: "event",
      event: { type: "session.execution.started", created: 2000, data: { sessionID: S1 } },
    });
    expect(second.queuedTurnIds).toEqual(["u3"]);
    expect(second.queuedMessages?.u2).toBeUndefined();

    const third = chatReducer(second, {
      type: "event",
      event: { type: "session.execution.started", created: 3000, data: { sessionID: S1 } },
    });
    expect(third.queuedTurnIds).toEqual([]);
    expect(third.queuedMessages?.u3).toBeUndefined();
    expect(third.messages.filter((m) => m.kind === "user")).toHaveLength(3);
    expect(third.turns.map((t) => t.id)).toEqual(["u1", "u2", "u3"]);
    expect(third.turns[0]).toMatchObject({ ended: 2000 });
    expect(third.turns[1]).toMatchObject({ started: 2000, ended: 3000 });
    expect(third.turns[2]).toMatchObject({ started: 3000 });
  });
});

describe("reloading a session that is still running", () => {
  const midTurn: SessionMessage[] = [
    { id: "u1", type: "user", text: "do it", time: { created: 1000 } },
    {
      id: "m1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 1100, completed: 1200 },
      content: [{ type: "text", text: "first step" }],
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ];

  it("keeps the last turn open when the server reports the session busy", () => {
    const state = chatReducer(initialChatState, {
      type: "load",
      sessionId: "s",
      busy: true,
      messages: midTurn,
      permissions: [],
      forms: [],
    });
    expect(state.busy).toBe(true);
    expect(state.turns).toHaveLength(1);
    // A completed last step does not mean the turn ended: the next step may be about to start.
    expect(state.turns[0].ended).toBeUndefined();
  });

  it("closes the turn when the session is idle", () => {
    const state = chatReducer(initialChatState, {
      type: "load",
      sessionId: "s",
      busy: false,
      messages: midTurn,
      permissions: [],
      forms: [],
    });
    expect(state.turns[0].ended).toBe(1200);
  });
});

describe("session usage on load", () => {
  it("keeps cost and tokens when history is loaded or resynced", () => {
    const usage = { cost: 0.42, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } };
    const state = chatReducer(initialChatState, {
      type: "load",
      sessionId: "s",
      messages: [],
      permissions: [],
      forms: [],
      usage,
    });
    expect(state.usage).toEqual(usage);
  });
});

describe("changed-file selectors", () => {
  const patch = "@@ -1 +1 @@\n-a\n+b\n";
  const file = (f: string, status: string, additions = 1, deletions = 1) => ({ file: f, patch, status, additions, deletions });

  function withToolFiles(...files: unknown[][]): ChatState {
    const content = files.map((batch, i) => ({
      type: "tool" as const,
      id: `t${i}`,
      name: "edit",
      state: { status: "completed" as const, input: {}, content: [], metadata: { files: batch } },
    }));
    const assistant: AssistantMessage = {
      id: "msg_1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 1, completed: 2 },
      content,
    };
    return open("s", [assistant]);
  }

  it("reconstructs changed files from completed tool metadata and dedupes by path", () => {
    const state = withToolFiles([file("b.ts", "added", 2, 0)], [file("a.ts", "unknown"), file("b.ts", "added", 5, 0)]);
    expect(selectToolChangedFiles(state)).toEqual([
      { file: "a.ts", patch, status: "modified", additions: 1, deletions: 1 },
      { file: "b.ts", patch, status: "added", additions: 5, deletions: 0 },
    ]);
  });

  it("ignores files from tools that are still running or asking permission", () => {
    const assistant: AssistantMessage = {
      id: "msg_1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: "t",
          name: "edit",
          state: { status: "running", input: {}, metadata: { files: [file("pending.ts", "modified")] } },
        },
      ],
    };
    expect(selectToolChangedFiles(open("s", [assistant]))).toEqual([]);
  });

  it("lets the server diff win over tool metadata for the same file", () => {
    const state = withToolFiles([file("a.ts", "modified", 1, 1)]);
    const authoritative = { ...file("a.ts", "added", 9, 0), status: "added" as const };
    expect(mergeChangedFiles([authoritative], state)).toEqual([authoritative]);
  });

  const serverFile = (f: string, status: FileDiff["status"], additions = 1, deletions = 1): FileDiff => ({
    file: f,
    patch,
    status,
    additions,
    deletions,
  });

  it("drops server diff rows for files this session never touched", () => {
    // OpenCode diffs from the session's start snapshot to HEAD, so a commit made by another
    // session after this one started shows up in its /diff response too.
    const state = withToolFiles([file("mine.ts", "modified", 2, 1)]);
    const fromAnotherSession = serverFile("theirs.ts", "modified", 7, 3);
    expect(mergeChangedFiles([serverFile("mine.ts", "modified", 4, 2), fromAnotherSession], state)).toEqual([
      serverFile("mine.ts", "modified", 4, 2),
    ]);
  });

  it("keeps the server patch for a path reported only by a step", () => {
    const event: ServerEvent = {
      type: "session.step.ended",
      created: 10,
      data: { sessionID: "s", assistantMessageID: "msg_1", finish: "stop", files: ["step.ts"] },
    };
    const state = chatReducer(open("s"), { type: "event", event });
    const authoritative = serverFile("step.ts", "modified", 5, 0);
    expect(mergeChangedFiles([serverFile("other.ts", "modified"), authoritative], state)).toEqual([authoritative]);
  });

  it("shows nothing when the session has no edits but the server diff is populated", () => {
    expect(mergeChangedFiles([serverFile("theirs.ts", "modified", 9, 2)], open("s"))).toEqual([]);
  });

  it("sums insertions/deletions for a turn, counting each file once with its latest patch", () => {
    const state = withToolFiles([file("b.ts", "added", 2, 0)], [file("a.ts", "modified", 3, 1), file("b.ts", "added", 5, 0)]);
    expect(selectTurnFileChanges(assistants(state))).toEqual({ additions: 8, deletions: 1 });
  });

  it("returns zero changes when the turn has no completed file edits", () => {
    const assistant: AssistantMessage = {
      id: "msg_1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: "t",
          name: "edit",
          state: { status: "running", input: {}, metadata: { files: [file("pending.ts", "modified")] } },
        },
      ],
    };
    expect(selectTurnFileChanges(assistants(open("s", [assistant])))).toEqual({ additions: 0, deletions: 0 });
  });

  it("keeps the counts captured live when a resync replaces the tool history", () => {
    const sid = "ses_counts";
    const base = { sessionID: sid, assistantMessageID: "m1" };
    const events: ServerEvent[] = [
      {
        type: "session.inbox.enqueued",
        created: 1000,
        data: { sessionID: sid, inboxID: "u1", item: { type: "user", payload: { text: "edit" } } },
      },
      { type: "session.step.started", created: 1100, data: { ...base, agent: "build" } },
      { type: "session.tool.input.started", created: 1200, data: { ...base, id: "t1", name: "edit" } },
      { type: "session.tool.called", created: 1250, data: { ...base, id: "t1", input: {} } },
      {
        type: "session.tool.success",
        created: 1300,
        data: {
          ...base,
          id: "t1",
          content: [],
          metadata: { files: [file("a.ts", "modified", 4, 2), file("b.ts", "added", 3, 0)] },
        },
      },
      {
        type: "session.step.ended",
        created: 1500,
        data: { ...base, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      },
      { type: "session.execution.succeeded", created: 1600, data: { sessionID: sid } },
    ];
    const live = chatReducer(open(sid), { type: "events", events });
    expect(live.turns.at(-1)).toMatchObject({ additions: 7, deletions: 2 });

    const history: AssistantMessage = {
      id: "m1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 1100, completed: 1500 },
      content: [
        { type: "tool", id: "t1", name: "edit", state: { status: "completed", input: {}, content: [], metadata: { status: "completed" } } },
      ],
      // Real assistant history carries tokens, so `turnsFromHistory` emits a turn for this id and
      // the resync must merge its live-captured file counts instead of replacing the whole turn.
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const resynced = chatReducer(live, {
      type: "append",
      delta: {
        sessionId: sid,
        messages: [
          { id: "u1", type: "user", text: "edit", time: { created: 1000 } },
          history,
          { id: "idle1", type: "idle", outcome: "succeeded", time: { created: 1600 } },
        ],
      },
    });
    expect(resynced.turns.some((t) => t.additions === 7 && t.deletions === 2)).toBe(true);
  });
});

describe("incremental resync", () => {
  const user = (id: string, created: number, text: string): SessionMessage => ({ id, type: "user", text, time: { created } });
  const assistant = (id: string, created: number, text: string): AssistantMessage => ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created, completed: created + 1 },
    content: [{ type: "text", text }],
  });

  it("appends a tail by id and keeps the existing messages in order", () => {
    const state = open("s", [user("u1", 1, "first"), assistant("a1", 2, "one")]);
    const next = chatReducer(state, {
      type: "append",
      delta: { sessionId: "s", messages: [user("u2", 3, "second"), assistant("a2", 4, "two")], permissions: [], forms: [] },
    });
    expect(next.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(next).not.toBe(state);
  });

  it("replaces a streaming card with the completed history entry", () => {
    const streaming = chatReducer(open("s"), {
      type: "event",
      event: { type: "session.step.started", data: { sessionID: "s", assistantMessageID: "a1", agent: "build" } },
    });
    expect(assistants(streaming)[0].done).toBe(false);
    const next = chatReducer(streaming, {
      type: "append",
      delta: { sessionId: "s", messages: [assistant("a1", 2, "done")], permissions: [], forms: [] },
    });
    expect(next.messages.map((m) => m.id)).toEqual(["a1"]);
    const [a] = assistants(next);
    expect(a.done).toBe(true);
    expect(a.parts.map((p) => (p.kind === "text" ? p.text : ""))).toEqual(["done"]);
  });

  it("finishes a streaming card and its turn on a local idle, but not on a network idle", () => {
    const streaming = chatReducer(open("s"), {
      type: "event",
      event: { type: "session.step.started", data: { sessionID: "s", assistantMessageID: "a1", agent: "build" } },
    });
    expect(assistants(streaming)[0].done).toBe(false);
    expect(streaming.turns.some((t) => t.ended === undefined)).toBe(true);

    const networkIdle = chatReducer(streaming, {
      type: "event",
      event: { type: "session.status", data: { sessionID: "s", status: { type: "idle" } } },
    });
    expect(assistants(networkIdle)[0].done).toBe(false);

    const localIdle = chatReducer(streaming, {
      type: "event",
      event: { type: "session.status", data: { sessionID: "s", status: { type: "idle", local: true } } },
    });
    expect(assistants(localIdle)[0].done).toBe(true);
    expect(localIdle.busy).toBe(false);
    expect(localIdle.turns.every((t) => t.ended !== undefined)).toBe(true);
  });

  it("does not duplicate a live failure notice when the resynced history reports the same outcome", () => {
    let state = chatReducer(open("s"), {
      type: "event",
      event: { type: "session.execution.failed", created: 1000, data: { sessionID: "s", error: { type: "unknown", message: "boom" } } },
    });
    const failed = () => state.messages.filter((m) => m.kind === "notice" && m.code === "failed");
    expect(failed()).toHaveLength(1);
    state = chatReducer(state, {
      type: "append",
      delta: {
        sessionId: "s",
        messages: [{ id: "idle_1", type: "idle", outcome: "failed", time: { created: 1001 }, error: { type: "unknown", message: "boom" } }],
        permissions: [],
        forms: [],
      },
    });
    expect(failed()).toHaveLength(1);
  });

  it("ignores an empty delta and a delta for another session", () => {
    const state = open("s", [user("u1", 1, "first")]);
    expect(chatReducer(state, { type: "append", delta: { sessionId: "s", messages: [] } })).toBe(state);
    expect(chatReducer(state, { type: "append", delta: { sessionId: "other", messages: [user("u2", 2, "x")] } })).toBe(state);
  });
});

describe("sessionTimeline", () => {
  const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  const user = (id: string, created: number, text: string): SessionMessage => ({ id, type: "user", text, time: { created } });
  const assistant = (id: string, created: number): AssistantMessage => ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created, completed: created + 10 },
    tokens,
    cost: 0.01,
    content: [{ type: "text", text: "ok" }],
  });
  const idle = (id: string, created: number): SessionMessage => ({ id, type: "idle", outcome: "succeeded", time: { created } });

  it("lists only turns with a real prompt, newest first, with their stats", () => {
    const state = open("s", [
      user("u1", 100, "first"),
      assistant("a1", 110),
      idle("i1", 150),
      user("u2", 200, "second"),
      assistant("a2", 310),
    ]);
    const withLive = chatReducer(state, {
      type: "event",
      event: { type: "session.execution.started", created: 300, data: { sessionID: "s" } },
    });
    const timeline = sessionTimeline(withLive);
    expect(timeline.map((entry) => entry.text)).toEqual(["second", "first"]);
    expect(timeline[0]).toMatchObject({ id: "u2", started: 200, tokens: 15, cost: 0.01 });
    // The live-only turn has a synthetic id and no prompt, so it is not a navigation target.
    expect(timeline.some((entry) => entry.id.startsWith("turn-"))).toBe(false);
  });

  it("is empty for a session without turns", () => {
    expect(sessionTimeline(open("s", [user("u1", 1, "hello")]))).toEqual([]);
  });
});
