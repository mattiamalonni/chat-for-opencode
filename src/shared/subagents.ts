import type { ServerEvent } from "./api";
import {
  chatReducer,
  eventSessionId,
  initialChatState,
  type ChatState,
  type ToolPart,
  type ToolStatus,
  type UiAssistantMessage,
} from "./chatReducer";
import type { SubagentSnapshot } from "./protocol";
import { parseSubagentReport } from "./subagentReport";

/** Keep at most this many child sessions alive in the webview: an orchestrator can spawn many. */
const MAX_SUBAGENTS = 30;

export interface SubagentMeta {
  parentId?: string;
  title?: string;
  agent?: string;
}

export interface SubagentState {
  byId: Record<string, ChatState>;
  meta: Record<string, SubagentMeta>;
  order: string[];
}

export const initialSubagentState: SubagentState = { byId: {}, meta: {}, order: [] };

export interface SubagentEvent {
  sessionId: string;
  event: ServerEvent;
}

export type SubagentAction =
  | { type: "snapshot"; snapshot: SubagentSnapshot }
  | { type: "events"; events: SubagentEvent[] }
  | { type: "clear" };

function emptyChild(sessionId: string): ChatState {
  return chatReducer(initialChatState, { type: "load", sessionId, messages: [], permissions: [], forms: [] });
}

/**
 * Child sessions are independent reducers: every event type the main chat already understands
 * (tools, text, reasoning, steps, usage) is reused to build the subagent's compact timeline.
 */
export function subagentReducer(state: SubagentState, action: SubagentAction): SubagentState {
  switch (action.type) {
    case "clear":
      return initialSubagentState;
    case "snapshot": {
      const { sessionId, parentId, title, agent, messages, permissions, forms, busy } = action.snapshot;
      const base = state.byId[sessionId] ?? emptyChild(sessionId);
      const previous = state.meta[sessionId] ?? {};
      // A later snapshot can omit optional fields; keep what we already know about the child.
      const nextTitle = title ?? base.title ?? previous.title;
      const nextAgent = agent ?? base.agent ?? previous.agent;
      const child = chatReducer(base, {
        type: "load",
        sessionId,
        title: nextTitle,
        agent: nextAgent,
        busy,
        messages,
        permissions,
        forms,
      });
      const order = state.order.includes(sessionId) ? state.order : [...state.order, sessionId];
      return {
        byId: { ...state.byId, [sessionId]: child },
        meta: {
          ...state.meta,
          [sessionId]: { parentId: parentId ?? previous.parentId, title: nextTitle, agent: nextAgent },
        },
        order,
      };
    }
    case "events": {
      if (action.events.length === 0) return state;
      // Group by child so a frame with many deltas rebuilds each child state once.
      const grouped = new Map<string, ServerEvent[]>();
      for (const { sessionId, event } of action.events) {
        const list = grouped.get(sessionId);
        if (list) list.push(event);
        else grouped.set(sessionId, [event]);
      }
      // Always copy: mutating the previous map in place would make the returned state identity
      // stale, so the webview would never re-render after the first batch of child events.
      const byId = { ...state.byId };
      let order = state.order;
      let added = false;
      for (const [sessionId, events] of grouped) {
        const existing = byId[sessionId];
        byId[sessionId] = chatReducer(existing ?? emptyChild(sessionId), { type: "events", events });
        if (!existing && !order.includes(sessionId)) {
          order = [...order, sessionId];
          added = true;
        }
      }
      if (added && order.length > MAX_SUBAGENTS) {
        const drop = order.slice(0, order.length - MAX_SUBAGENTS);
        for (const id of drop) delete byId[id];
        order = order.slice(drop.length);
      }
      return { ...state, byId, order };
    }
  }
}

// ---- view --------------------------------------------------------------------------------

export { parseSubagentReport, type SubagentReport } from "./subagentReport";

/** The v2 tool is `subagent`; `task` is kept for compatibility with other builds. */
export function isSubagentTool(part: ToolPart): boolean {
  return part.name === "subagent" || part.name === "task";
}

/** The child session id is published by `session.tool.progress`/`success` metadata. */
export function subagentChildId(part: ToolPart): string | undefined {
  const id = part.metadata?.sessionID;
  return typeof id === "string" && id ? id : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Live tool input can be a JSON string on the wire; the card still needs its fields. */
export function toolObject(part: ToolPart): Record<string, unknown> {
  if (part.input && typeof part.input === "object" && !Array.isArray(part.input)) return part.input;
  if (part.inputText) {
    try {
      const parsed: unknown = JSON.parse(part.inputText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON: fall through to an empty object.
    }
  }
  return {};
}

const SUMMARY_KEYS = ["description", "filePath", "path", "file", "command", "pattern", "query", "url", "name", "prompt"];

export function toolInputSummary(part: ToolPart): string {
  const input = toolObject(part);
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.split("\n")[0].slice(0, 120);
  }
  if (Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return "";
}

export type SubagentStatus = "running" | "completed" | "error" | "cancelled" | "pending";

export interface SubagentToolView {
  name: string;
  summary: string;
  status: ToolStatus;
}

export type SubagentActivity =
  | { kind: "thinking" }
  | { kind: "tool"; tool: SubagentToolView }
  | { kind: "text"; text: string }
  | { kind: "done" }
  | { kind: "idle" };

export interface SubagentView {
  sessionId?: string;
  title: string;
  agent: string;
  status: SubagentStatus;
  activity: SubagentActivity;
  tools: SubagentToolView[];
  task?: string;
  report?: string;
  started?: number;
  ended?: number;
}

function lastAssistant(messages: ChatState["messages"]): UiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "assistant") return messages[i] as UiAssistantMessage;
  }
  return undefined;
}

function reportOf(child: ChatState | undefined): string | undefined {
  const assistant = lastAssistant(child?.messages ?? []);
  if (!assistant) return undefined;
  for (let i = assistant.parts.length - 1; i >= 0; i--) {
    const part = assistant.parts[i];
    if (part.kind === "text" && part.text.trim()) return part.text;
  }
  return undefined;
}

/** Compact, read-only projection of a child session used by the inline subagent card. */
export function subagentView(
  part: ToolPart,
  child?: ChatState,
  meta?: SubagentMeta,
  reports?: Record<string, string>,
): SubagentView {
  const input = toolObject(part);
  const sessionId = subagentChildId(part);
  const title = str(input.description) || meta?.title || "";
  const agent = str(input.agent) || child?.agent || meta?.agent || "";
  const metaStatus = str(part.metadata?.status);
  const messages = child?.messages ?? [];

  let status: SubagentStatus;
  if (part.status === "error" || metaStatus === "error") status = "error";
  else if (metaStatus === "cancelled") status = "cancelled";
  else if (part.status === "completed" || metaStatus === "completed") status = "completed";
  else if (child && !child.busy && messages.length > 0) status = "completed";
  else if (part.status === "streaming" && !child) status = "pending";
  else status = "running";

  const tools: SubagentToolView[] = [];
  for (const message of messages) {
    if (message.kind !== "assistant") continue;
    for (const p of message.parts) {
      if (p.kind === "tool") tools.push({ name: p.name, summary: toolInputSummary(p), status: p.status });
    }
  }

  const outputText = part.output.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  // Foreground children return the report inside the tool result; background children announce it
  // later as a synthetic notification, which the host keeps in `reports` keyed by child session.
  const report = reportOf(child) ?? parseSubagentReport(outputText)?.report ?? (sessionId ? reports?.[sessionId] : undefined);
  const running = [...tools].reverse().find((t) => t.status === "running" || t.status === "streaming");
  let activity: SubagentActivity;
  if (running) activity = { kind: "tool", tool: running };
  else if (child?.busy) {
    const assistant = lastAssistant(messages);
    const streaming = assistant?.parts.find((p) => p.kind === "text" && !p.done && p.text.trim());
    activity = streaming && streaming.kind === "text" ? { kind: "text", text: streaming.text } : { kind: "thinking" };
  } else if (report) activity = { kind: "text", text: report };
  else if (status === "completed" || status === "error" || status === "cancelled") activity = { kind: "done" };
  else activity = { kind: "idle" };

  const firstUser = messages.find((m) => m.kind === "user");
  const started = messages[0]?.created;
  let ended: number | undefined;
  if (started !== undefined && child && !child.busy) {
    for (let i = messages.length - 1; i >= 0; i--) {
      ended = messages[i].created;
      break;
    }
  }

  return {
    sessionId,
    title,
    agent,
    status,
    activity,
    tools,
    task: firstUser && firstUser.kind === "user" ? firstUser.text : undefined,
    report,
    started,
    ended,
  };
}

/** Whether an event belongs to a child session we track (host-side helper). */
export function isChildEvent(event: ServerEvent, childIds: ReadonlySet<string>): boolean {
  const sid = eventSessionId(event);
  return !!sid && childIds.has(sid);
}
