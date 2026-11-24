import type { AssistantMessage, ServerEvent, SessionMessage } from "../api";
import type { SessionDelta } from "../protocol";
import { parseSubagentReport } from "../subagentReport";
import type { ChatAction, ChatState, UiAssistantMessage, UiMessage, UiNotice, UiPart } from "./types";
import { contextTokensOf, eventSessionId, str, type Data } from "./helpers";
import { cmp, mergeTurns, turnsFromHistory } from "./turns";
import { carrySubagentLinks, reportsFromHistory } from "./subagentLinks";
import { isIncomplete, isTerminalMessage } from "./sessionStatus";

type DeltaTarget = "text" | "reasoning" | "tool-input";

/** Identity of the part a delta appends to, or `undefined` when the event is not a delta. */
function deltaTarget(event: ServerEvent): string | undefined {
  let kind: DeltaTarget;
  switch (event.type) {
    case "session.text.delta":
      kind = "text";
      break;
    case "session.reasoning.delta":
      kind = "reasoning";
      break;
    case "session.tool.input.delta":
      kind = "tool-input";
      break;
    default:
      return undefined;
  }
  const d = event.data as Data | undefined;
  if (!d) return undefined;
  const messageId = str(d, "assistantMessageID");
  if (!messageId) return undefined;
  // Include the session: a batch can interleave events from several sessions (see the fixtures).
  const sessionId = eventSessionId(event) ?? "";
  const partId = kind === "tool-input" ? `id:${str(d, "id")}` : `ordinal:${String(d.ordinal ?? 0)}`;
  return `${sessionId}|${kind}|${messageId}|${partId}`;
}

/**
 * Merges adjacent deltas that target the same part. Concatenation is associative, so a run of
 * `text + "a" + "b" + "c"` is indistinguishable from a single `text + "abc"` once reduced — but it
 * costs one message/part update instead of three. Only *adjacent* events are merged, preserving the
 * relative order of every other event (starts, ends, tool calls, other sessions, ...).
 */
export function coalesceDeltas(events: ServerEvent[]): ServerEvent[] {
  if (events.length < 2) return events;
  const out: ServerEvent[] = [];
  let lastTarget: string | undefined;
  for (const event of events) {
    const target = deltaTarget(event);
    const previous = out[out.length - 1];
    if (target !== undefined && previous && lastTarget === target) {
      const prevData = (previous.data ?? {}) as Data;
      const data = (event.data ?? {}) as Data;
      out[out.length - 1] = {
        ...previous,
        data: { ...prevData, delta: str(prevData, "delta") + str(data, "delta") },
      };
      // `lastTarget` is unchanged: the merged event still targets the same part.
    } else {
      out.push(event);
      lastTarget = target;
    }
  }
  return out;
}

export function loadHistory(action: Extract<ChatAction, { type: "load" }>, previous: ChatState): ChatState {
  const sorted = [...action.messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  const messages: UiMessage[] = [];
  for (const m of sorted) {
    const ui = fromHistory(m);
    if (ui) messages.push(ui);
  }
  // A resync of the same session rebuilds cards from history, where a running `subagent` tool has
  // no `metadata.sessionID` yet. Carry the id we linked earlier over by tool id, or a manual Sync
  // would make the "Open subagent conversation" action disappear again.
  if (previous.sessionId === action.sessionId) {
    const previousById = new Map(previous.messages.map((m) => [m.id, m]));
    for (let i = 0; i < messages.length; i++) {
      messages[i] = carrySubagentLinks(previousById.get(messages[i].id), messages[i]);
    }
  }
  let contextTokens: number | undefined;
  for (const m of sorted) {
    if (m.type === "assistant") contextTokens = contextTokensOf(m.tokens) ?? contextTokens;
    // A completed compaction replaces the context with a summary of unknown size.
    else if (m.type === "compaction" && (m as { status?: string }).status === "completed") contextTokens = undefined;
  }
  const subagentReports = reportsFromHistory(sorted);
  const last = sorted[sorted.length - 1];
  // A terminal message wins over a stale `busy` flag from the host (see sessionIsBusy).
  const busy = isTerminalMessage(last) ? false : (action.busy ?? (last !== undefined && isIncomplete(last)));
  return {
    sessionId: action.sessionId,
    title: action.title,
    agent: action.agent,
    model: action.model,
    messages,
    subagentReports,
    turns: turnsFromHistory(sorted, true, busy),
    permissions: action.permissions,
    forms: action.forms,
    busy,
    contextTokens,
    usage: action.usage,
  };
}

/**
 * Merges a resync tail into the live conversation. Messages are keyed by id so a completed
 * history entry replaces the streaming card the events built, without rebuilding the whole state:
 * scroll position, dismissed-change state and staged attachments stay untouched.
 */
export function appendDelta(state: ChatState, delta: SessionDelta): ChatState {
  const sorted = [...delta.messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  if (
    sorted.length === 0 &&
    delta.permissions === undefined &&
    delta.forms === undefined &&
    delta.usage === undefined &&
    delta.busy === undefined
  ) {
    return state;
  }
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  // A live terminal event already added a notice keyed by the *event* id; the resynced history
  // message describing the same outcome has a different id and would otherwise duplicate it.
  const similarNoticeExists = (ui: UiMessage): boolean =>
    ui.kind === "notice" &&
    [...byId.values()].some((m) => m.kind === "notice" && m.code === ui.code && Math.abs(m.created - ui.created) < 2000);
  for (const m of sorted) {
    const ui = fromHistory(m);
    if (!ui) continue;
    if (byId.has(ui.id) || !similarNoticeExists(ui)) byId.set(ui.id, carrySubagentLinks(byId.get(ui.id), ui));
  }
  const messages = [...byId.values()].sort((a, b) => a.created - b.created || cmp(a.id, b.id));
  let contextTokens = state.contextTokens;
  for (const m of sorted) {
    if (m.type === "assistant") contextTokens = contextTokensOf(m.tokens) ?? contextTokens;
    else if (m.type === "compaction" && (m as { status?: string }).status === "completed") contextTokens = undefined;
  }
  const reports = reportsFromHistory(sorted);
  return {
    ...state,
    messages,
    turns: mergeTurns(state.turns, turnsFromHistory(sorted, true, delta.busy ?? state.busy)),
    subagentReports: reports ? { ...(state.subagentReports ?? {}), ...reports } : state.subagentReports,
    permissions: delta.permissions ?? state.permissions,
    forms: delta.forms ?? state.forms,
    usage: delta.usage ?? state.usage,
    busy: delta.busy ?? state.busy,
    title: delta.title ?? state.title,
    agent: delta.agent ?? state.agent,
    model: delta.model ?? state.model,
    contextTokens,
  };
}

function fromHistory(m: SessionMessage): UiMessage | undefined {
  switch (m.type) {
    case "user":
      return {
        kind: "user",
        id: m.id,
        created: m.time.created,
        text: m.text,
        files: (m.files ?? []).map((f) => ({ uri: f.uri ?? f.source?.uri ?? "", name: f.name })).filter((f) => f.uri || f.name),
      };
    case "assistant":
      return fromAssistant(m);
    case "idle":
      if (m.outcome === "interrupted") return notice(m.id, m.time.created, "warning", "interrupted", "");
      if (m.outcome === "failed") return notice(m.id, m.time.created, "error", "failed", m.error?.message ?? "");
      return undefined;
    case "agent-switched":
      return notice(m.id, m.time.created, "info", "agent", m.agent ?? "");
    case "model-switched":
      return notice(m.id, m.time.created, "info", "model", m.model ? `${m.model.providerID}/${m.model.id}` : "");
    case "compaction":
      return notice(m.id, m.time.created, "info", "compaction", "");
    case "synthetic":
      // A subagent completion is shown inside its tool card, not as a raw XML notice here.
      if (parseSubagentReport(m.description ?? m.text)) return undefined;
      return notice(m.id, m.time.created, "info", "synthetic", m.description ?? m.text ?? "");
    case "shell":
      return notice(m.id, m.time.created, "info", "shell", m.command ?? "");
    default:
      return undefined;
  }
}

export function notice(id: string, created: number, level: UiNotice["level"], code: UiNotice["code"], text: string): UiNotice {
  return { kind: "notice", id, created, level, code, text };
}

function fromAssistant(m: AssistantMessage): UiAssistantMessage {
  const counters = { text: 0, reasoning: 0 };
  const parts: UiPart[] = m.content.map((c): UiPart => {
    if (c.type === "tool") {
      const s = c.state;
      return {
        kind: "tool",
        key: `tool:${c.id}`,
        id: c.id,
        name: c.name,
        status: s.status,
        inputText: typeof s.input === "string" ? s.input : JSON.stringify(s.input, null, 2),
        input: typeof s.input === "string" ? undefined : s.input,
        output: s.status === "completed" ? s.content : s.status === "error" ? (s.content ?? []) : [],
        metadata: "metadata" in s ? s.metadata : undefined,
        error: s.status === "error" ? s.error : undefined,
      };
    }
    const ordinal = counters[c.type]++;
    return { kind: c.type, key: `${c.type}:${ordinal}`, text: c.text, done: true };
  });
  return {
    kind: "assistant",
    id: m.id,
    created: m.time.created,
    agent: m.agent,
    model: m.model,
    parts,
    done: m.time.completed !== undefined,
    finish: m.finish,
    error: m.error,
  };
}
