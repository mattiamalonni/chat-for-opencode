import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../../src/shared/api";
import { chatReducer, eventSessionId, initialChatState, type ToolPart } from "../../src/shared/chatReducer";
import {
  initialSubagentState,
  isSubagentTool,
  parseSubagentReport,
  pushSubagentSession,
  subagentChildId,
  subagentReducer,
  subagentView,
  toolInputSummary,
  toolObject,
  truncateSubagentStack,
  type SubagentEvent,
} from "../../src/shared/subagents";

/** Real stream captured from opencode 2.2.7 while a `subagent` tool spawned an `explore` child. */
function fixture(name = "real-sse-subagent.jsonl"): ServerEvent[] {
  return readFileSync(join(__dirname, "../fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ServerEvent);
}

const events = fixture();
const parentId = "ses_e0d1a594affeRHT5ks6SqFzeKs";
const childId = "ses_e0d1a3fbaffewFAJSNZEYUBF3e";

function open(sessionId: string) {
  return chatReducer(initialChatState, { type: "load", sessionId, messages: [], permissions: [], forms: [] });
}

describe("subagents", () => {
  it("summarises a question tool from the headers of its bundled questions", () => {
    const part: ToolPart = {
      kind: "tool",
      key: "q",
      id: "q",
      name: "question",
      status: "completed",
      inputText: "",
      input: {
        questions: [{ header: "Tipo di modifica", question: "Che piccola modifica vuoi che faccia?", options: [] }],
      },
      output: [],
    };
    expect(toolInputSummary(part)).toBe("Tipo di modifica");
    expect(toolInputSummary({ ...part, input: { questions: [{ header: "Uno" }, { header: "Due" }] } })).toBe("Uno, Due");
    // A question without a header still gets a useful label from its text.
    expect(toolInputSummary({ ...part, input: { questions: [{ question: "Favorite color?" }] } })).toBe("Favorite color?");
  });

  it("recognises the subagent tool and reads its child id from progress metadata", () => {
    const parent = chatReducer(open(parentId), { type: "events", events });
    const tool = parent.messages
      .flatMap((m) => (m.kind === "assistant" ? m.parts : []))
      .find((p) => p.kind === "tool" && isSubagentTool(p));
    expect(tool).toBeDefined();
    expect(tool && tool.kind === "tool" && subagentChildId(tool)).toBe(childId);
    // Live `input` is a JSON string on the wire; the card must still read its fields.
    expect(tool && tool.kind === "tool" && toolObject(tool).description).toBe("List files in working directory");
  });

  it("builds a compact child timeline from the live events of the child session", () => {
    const childEvents: SubagentEvent[] = events
      .filter((e) => eventSessionId(e) === childId)
      .map((event) => ({ sessionId: childId, event }));
    expect(childEvents.length).toBeGreaterThan(10);
    let state = subagentReducer(initialSubagentState, { type: "events", events: childEvents });
    expect(state.order).toEqual([childId]);
    const child = state.byId[childId];
    expect(child).toBeDefined();
    expect(child.busy).toBe(false);
    const tools = child.messages.flatMap((m) => (m.kind === "assistant" ? m.parts : [])).filter((p) => p.kind === "tool");
    expect(tools.length).toBeGreaterThan(0);

    const parent = chatReducer(open(parentId), { type: "events", events });
    const tool = parent.messages
      .flatMap((m) => (m.kind === "assistant" ? m.parts : []))
      .find((p) => p.kind === "tool" && isSubagentTool(p));
    expect(tool?.kind === "tool" && tool).toBeTruthy();
    const view = subagentView(tool && tool.kind === "tool" ? tool : ({} as never), child, state.meta[childId]);
    expect(view.status).toBe("completed");
    expect(view.agent).toBe("explore");
    expect(view.title).toBe("List files in working directory");
    expect(view.tools.length).toBeGreaterThan(0);
    expect(view.report).toContain("The directory contains only a `.git` repository");
    expect(view.started).toBeDefined();
    expect(view.ended).toBeDefined();

    state = subagentReducer(state, { type: "clear" });
    expect(state.order).toEqual([]);
    expect(state.byId[childId]).toBeUndefined();
  });

  it("seeds a child from history and replaces it with a newer snapshot", () => {
    const first = subagentReducer(initialSubagentState, {
      type: "snapshot",
      snapshot: {
        sessionId: childId,
        parentId,
        title: "Explore files",
        agent: "explore",
        messages: [],
        permissions: [],
        forms: [],
        busy: true,
      },
    });
    expect(first.meta[childId]).toEqual({ parentId, title: "Explore files", agent: "explore" });
    expect(first.byId[childId].busy).toBe(true);
    const second = subagentReducer(first, {
      type: "snapshot",
      snapshot: { sessionId: childId, messages: [], permissions: [], forms: [], busy: false },
    });
    // Empty optional fields must not erase metadata already known for the child.
    expect(second.meta[childId].agent).toBe("explore");
    expect(second.byId[childId].busy).toBe(false);
    expect(second.order).toEqual([childId]);
  });

  it("returns a fresh state for every batch so the webview re-renders", () => {
    const childEvents = events.filter((e) => eventSessionId(e) === childId);
    const half = Math.floor(childEvents.length / 2);
    const first = subagentReducer(initialSubagentState, {
      type: "events",
      events: childEvents.slice(0, half).map((event) => ({ sessionId: childId, event })),
    });
    const second = subagentReducer(first, {
      type: "events",
      events: childEvents.slice(half).map((event) => ({ sessionId: childId, event })),
    });
    expect(second).not.toBe(first);
    expect(second.byId).not.toBe(first.byId);
    expect(second.byId[childId]).not.toBe(first.byId[childId]);
    expect(second.byId[childId].messages.length).toBeGreaterThan(first.byId[childId].messages.length);
  });

  it("shows a background child's report from the synthetic completion notification", () => {
    const bg = fixture("real-sse-subagent-background.jsonl");
    const bgParent = "ses_e0cfd7ffaffem5qaFtNbJsTQHB";
    const bgChild = "ses_e0cfd6f15ffeP8bUsSdo7bEvEK";
    const noticeIndex = bg.findIndex(
      (e) => e.type === "session.inbox.enqueued" && (e.data as { item?: { type?: string } }).item?.type === "synthetic",
    );
    expect(noticeIndex).toBeGreaterThan(0);
    const parsed = parseSubagentReport(
      (bg[noticeIndex].data as { item: { payload: { text: string } } }).item.payload.text,
    );
    expect(parsed?.sessionId).toBe(bgChild);
    expect(parsed?.state).toBe("completed");
    expect(parsed?.report).toContain("# Project Structure Analysis Report");

    const parent = chatReducer(open(bgParent), { type: "events", events: bg.slice(0, noticeIndex + 1) });
    expect(parent.subagentReports?.[bgChild]).toContain("# Project Structure Analysis Report");
    // The raw XML notification must not be dumped into the conversation as a user message.
    expect(parent.messages.some((m) => m.kind === "user" && m.text.includes("<subagent"))).toBe(false);

    const tool = parent.messages
      .flatMap((m) => (m.kind === "assistant" ? m.parts : []))
      .find((p) => p.kind === "tool" && isSubagentTool(p));
    expect(tool).toBeDefined();
    // No child state (background events can arrive long after the tool call): the report still shows.
    const view = subagentView(tool && tool.kind === "tool" ? tool : ({} as never), undefined, undefined, parent.subagentReports);
    expect(view.status).toBe("completed");
    expect(view.report).toContain("# Project Structure Analysis Report");
    expect(view.activity.kind === "text" && view.activity.text).toContain("# Project Structure Analysis Report");
  });

  it("reports a running activity while the child is mid-tool", () => {
    const childEvents = events.filter((e) => eventSessionId(e) === childId);
    const called = childEvents.findIndex((e) => e.type === "session.tool.called");
    const child = chatReducer(open(childId), { type: "events", events: childEvents.slice(0, called + 1) });
    const tool = {
      kind: "tool" as const,
      key: "tool:t",
      id: "t",
      name: "subagent",
      status: "running" as const,
      inputText: '{"agent":"explore","description":"List files"}',
      output: [],
      metadata: { sessionID: childId, status: "running" },
    };
    const view = subagentView(tool, child);
    expect(view.status).toBe("running");
    expect(view.activity.kind === "tool" && view.activity.tool.name).toBe("shell");
  });

  it("navigates the read-only conversation stack without duplicating ancestors", () => {
    const stack = pushSubagentSession([], "a");
    expect(pushSubagentSession(stack, "b")).toEqual(["a", "b"]);
    // A nested card can point back to an ancestor: jump there instead of stacking it twice.
    expect(pushSubagentSession(["a", "b", "c"], "a")).toEqual(["a"]);
    expect(truncateSubagentStack(["a", "b", "c"], 1)).toEqual(["a", "b"]);
    expect(truncateSubagentStack(["a", "b", "c"], -1)).toEqual([]);
  });
});
