import type {
  AssistantMessage,
  FileDiff,
  FormRequest,
  ModelRef,
  PermissionRequest,
  ServerEvent,
  SessionInfo,
  SessionMessage,
  StructuredError,
  TokenUsage,
  ToolContent,
} from "./api";
import type { SessionDelta, SessionSummary } from "./protocol";
import { parseSubagentReport } from "./subagentReport";

export type ToolStatus = "streaming" | "running" | "completed" | "error";

export interface TextPart {
  kind: "text" | "reasoning";
  key: string;
  text: string;
  done: boolean;
}

export interface ToolPart {
  kind: "tool";
  key: string;
  id: string;
  name: string;
  status: ToolStatus;
  inputText: string;
  input?: Record<string, unknown>;
  output: ToolContent[];
  metadata?: Record<string, unknown>;
  error?: StructuredError;
}

export type UiPart = TextPart | ToolPart;

export interface UiUserMessage {
  kind: "user";
  id: string;
  created: number;
  text: string;
  files: { uri: string; name?: string }[];
}

export interface UiAssistantMessage {
  kind: "assistant";
  id: string;
  created: number;
  agent: string;
  model?: ModelRef;
  parts: UiPart[];
  done: boolean;
  finish?: string;
  error?: StructuredError;
  retry?: { attempt: number; message: string };
}

export interface UiNotice {
  kind: "notice";
  id: string;
  created: number;
  level: "info" | "warning" | "error";
  code: "interrupted" | "failed" | "agent" | "model" | "compaction" | "synthetic" | "shell" | "other";
  text: string;
}

export type UiMessage = UiUserMessage | UiAssistantMessage | UiNotice;

export interface Todo {
  content: string;
  status: string;
}

/** Wall-clock time and summed usage for one user turn: input → end of every step. */
export interface TurnStats {
  /** User message that opened the turn (its inbox id in the live stream). */
  id: string;
  started: number;
  ended?: number;
  /** Sum of the per-step token counts, so tool-using turns include every LLM call. */
  tokens?: TokenUsage;
  cost?: number;
}

export interface ChatState {
  sessionId: string | null;
  title?: string;
  messages: UiMessage[];
  turns: TurnStats[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  busy: boolean;
  retry?: { attempt: number; message: string; next?: number };
  lastError?: StructuredError;
  usage?: { cost: number; tokens: TokenUsage };
  /** Estimated tokens in the model context after the last step (undefined until known / after compaction). */
  contextTokens?: number;
  /** Paths reported by completed/failed steps, used to list changes without `/diff` patches. */
  touchedFiles?: string[];
  /** Final reports of background subagents, announced as synthetic messages keyed by child id. */
  subagentReports?: Record<string, string>;
  agent?: string;
  model?: ModelRef;
}

export type ChatAction =
  | {
      type: "load";
      sessionId: string | null;
      title?: string;
      agent?: string;
      model?: ModelRef;
      busy?: boolean;
      messages: SessionMessage[];
      permissions: PermissionRequest[];
      forms: FormRequest[];
      usage?: ChatState["usage"];
    }
  | { type: "append"; delta: SessionDelta }
  | { type: "event"; event: ServerEvent }
  | { type: "events"; events: ServerEvent[] }
  | { type: "clearError" };

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
  turns: [],
  permissions: [],
  forms: [],
  busy: false,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "load":
      return loadHistory(action);
    case "append":
      return state.sessionId === action.delta.sessionId ? appendDelta(state, action.delta) : state;
    case "event":
      return applyEvent(state, action.event);
    case "events":
      // A streaming frame carries many consecutive deltas for the same part. Applying each one
      // would scan and copy the whole message list over and over (O(events × history)). Deltas for
      // one part are pure string appends, so fold adjacent ones into a single event first.
      return coalesceDeltas(action.events).reduce(applyEvent, state);
    case "clearError":
      return { ...state, lastError: undefined };
  }
}

type DeltaTarget = "text" | "reasoning" | "tool-input";

/** Identity of the part a delta appends to, or `undefined` when the event is not a delta. */
function deltaTarget(event: ServerEvent): string | undefined {
  let kind: DeltaTarget;
  switch (event.type) {
    case "session.text.delta": kind = "text"; break;
    case "session.reasoning.delta": kind = "reasoning"; break;
    case "session.tool.input.delta": kind = "tool-input"; break;
    default: return undefined;
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
function coalesceDeltas(events: ServerEvent[]): ServerEvent[] {
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

/**
 * Tokens the conversation occupies after a step: the prompt (`input` excludes cached tokens, as
 * verified against opencode 2.2.7) plus what the model produced in that step.
 */
export function contextTokensOf(tokens: TokenUsage | undefined): number | undefined {
  if (!tokens) return undefined;
  const total = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
  return total > 0 ? total : undefined;
}

/** Background children announce their report inside a synthetic message after the parent turn. */
function reportsFromHistory(messages: SessionMessage[]): Record<string, string> | undefined {
  const reports: Record<string, string> = {};
  for (const m of messages) {
    if (m.type !== "synthetic") continue;
    const parsed = parseSubagentReport((m as { text?: string; description?: string }).text ?? (m as { description?: string }).description);
    if (parsed) reports[parsed.sessionId] = parsed.report;
  }
  return Object.keys(reports).length > 0 ? reports : undefined;
}

function loadHistory(action: Extract<ChatAction, { type: "load" }>): ChatState {
  const sorted = [...action.messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  const messages: UiMessage[] = [];
  for (const m of sorted) {
    const ui = fromHistory(m);
    if (ui) messages.push(ui);
  }
  let contextTokens: number | undefined;
  for (const m of sorted) {
    if (m.type === "assistant") contextTokens = contextTokensOf(m.tokens) ?? contextTokens;
    // A completed compaction replaces the context with a summary of unknown size.
    else if (m.type === "compaction" && (m as { status?: string }).status === "completed") contextTokens = undefined;
  }
  const subagentReports = reportsFromHistory(sorted);
  const last = sorted[sorted.length - 1];
  // A terminal idle message wins over a stale `busy` flag from the host (see sessionIsBusy).
  const busy = last?.type === "idle" ? false : (action.busy ?? (last !== undefined && isIncomplete(last)));
  return {
    sessionId: action.sessionId,
    title: action.title,
    agent: action.agent,
    model: action.model,
    messages,
    subagentReports,
    turns: turnsFromHistory(sorted, true),
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
function appendDelta(state: ChatState, delta: SessionDelta): ChatState {
  const sorted = [...delta.messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  if (sorted.length === 0 && delta.permissions === undefined && delta.forms === undefined && delta.usage === undefined && delta.busy === undefined) {
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
    if (byId.has(ui.id) || !similarNoticeExists(ui)) byId.set(ui.id, ui);
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
    turns: mergeTurns(state.turns, turnsFromHistory(sorted, true)),
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

function isIncomplete(m: SessionMessage): boolean {
  return m.type === "assistant" && m.time.completed === undefined;
}

/**
 * Whether a session still has an execution running.
 *
 * `time.busy` / `time.idle` are the timestamps of the last transitions to busy and idle. The
 * real server can leave them inconsistent right after an interrupt (an interrupted session has
 * been observed with `busy` newer than `idle`), which makes a naive comparison report the
 * session as busy forever. A terminal `idle` message in the history is authoritative: once it
 * is present, the turn is over, regardless of what the timestamps say.
 */
export function sessionIsBusy(time: SessionInfo["time"], messages: SessionMessage[]): boolean {
  // Ignore trailing bookkeeping messages (e.g. compaction) and look at the last turn event.
  let last: SessionMessage | undefined;
  for (const m of messages) {
    if (m.type === "user" || m.type === "assistant" || m.type === "idle") last = m;
  }
  if (last?.type === "idle") return false;
  return sessionLooksBusy(time);
}

/** Cheap timestamp-only check, for when the session history is not available. */
export function sessionLooksBusy(time: SessionInfo["time"]): boolean {
  return (time.busy ?? 0) > (time.idle ?? 0);
}

/**
 * Builds the list entry for a session. When a history is available, a terminal `idle` message is
 * authoritative: the timestamps alone can stay stale after an interrupt, which would otherwise
 * leave the session marked as running in the list even though the chat itself is idle.
 */
export function toSessionSummary(info: SessionInfo, messages?: SessionMessage[], needsInput = false): SessionSummary {
  return {
    id: info.id,
    title: info.title ?? "",
    updated: info.time.updated,
    busy: messages ? sessionIsBusy(info.time, messages) : sessionLooksBusy(info.time),
    needsInput,
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addTokens(base: TokenUsage | undefined, extra: TokenUsage | undefined): TokenUsage | undefined {
  if (!extra) return base;
  const b = base ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    input: b.input + (extra.input || 0),
    output: b.output + (extra.output || 0),
    reasoning: b.reasoning + (extra.reasoning || 0),
    cache: { read: b.cache.read + (extra.cache?.read || 0), write: b.cache.write + (extra.cache?.write || 0) },
  };
}

/**
 * Rebuilds one summary per turn from history. A user message opens a turn, the assistant
 * messages that follow are its steps, and an idle (or the next user message) closes it.
 */
function turnsFromHistory(messages: SessionMessage[], alreadySorted = false): TurnStats[] {
  // Both callers pass an array they just sorted with the same comparator. Re-sorting would copy
  // and run O(n log n) comparisons a second time on every load and every resync.
  const sorted = alreadySorted ? messages : [...messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  const turns: TurnStats[] = [];
  let current: TurnStats | undefined;
  let lastCompleted: number | undefined;
  for (const m of sorted) {
    if (m.type === "user") {
      if (current && current.ended === undefined) current.ended = m.time.created;
      current = { id: m.id, started: m.time.created };
      lastCompleted = undefined;
      turns.push(current);
    } else if (m.type === "assistant" && current) {
      current.tokens = addTokens(current.tokens, m.tokens);
      if (typeof m.cost === "number") current.cost = (current.cost ?? 0) + m.cost;
      if (m.time.completed !== undefined) lastCompleted = Math.max(lastCompleted ?? 0, m.time.completed);
    } else if (m.type === "idle" && current) {
      current.ended = m.time.created;
      current = undefined;
    }
  }
  // The last turn may have no idle entry yet; the assistant's completion time is the next best end.
  if (current && current.ended === undefined && lastCompleted !== undefined) current.ended = lastCompleted;
  return turns.filter((t) => t.ended !== undefined && t.tokens !== undefined);
}

function openTurn(state: ChatState, id: string, started: number): TurnStats[] {
  const turns = state.turns.slice();
  // A queued message can arrive before the previous execution's terminal event.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].ended === undefined) turns[i] = { ...turns[i], ended: started };
  }
  turns.push({ id, started });
  return turns;
}

function withOpenTurn(state: ChatState, update: (t: TurnStats) => TurnStats): TurnStats[] {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    if (state.turns[i].ended === undefined) {
      const turns = state.turns.slice();
      turns[i] = update(turns[i]);
      return turns;
    }
  }
  return state.turns;
}

function endTurn(state: ChatState, ended: number): TurnStats[] {
  return withOpenTurn(state, (t) => ({ ...t, ended }));
}

/** A resync tail is authoritative for the turns it contains; live-only turns stay untouched. */
function mergeTurns(current: TurnStats[], incoming: TurnStats[]): TurnStats[] {
  if (incoming.length === 0) return current;
  const merged = current.slice();
  // Index by id once instead of scanning the whole list for every incoming turn (O(n·m) → O(n+m)).
  const indexById = new Map(merged.map((t, i) => [t.id, i] as const));
  for (const t of incoming) {
    const at = indexById.get(t.id);
    if (at === undefined) {
      indexById.set(t.id, merged.length);
      merged.push(t);
    } else {
      merged[at] = t;
    }
  }
  return merged;
}

function fromHistory(m: SessionMessage): UiMessage | undefined {
  switch (m.type) {
    case "user":
      return {
        kind: "user",
        id: m.id,
        created: m.time.created,
        text: m.text,
        files: (m.files ?? [])
          .map((f) => ({ uri: f.uri ?? f.source?.uri ?? "", name: f.name }))
          .filter((f) => f.uri || f.name),
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

function notice(id: string, created: number, level: UiNotice["level"], code: UiNotice["code"], text: string): UiNotice {
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

// ---- live events -------------------------------------------------------------------------

type Data = Record<string, unknown>;

function str(d: Data, k: string): string {
  const v = d[k];
  return typeof v === "string" ? v : "";
}

/**
 * Live `permission.asked`/`form.created` events come straight off the wire (the resync path, by
 * contrast, normalises them in the host). Guarantee the fields the cards dereference so one
 * malformed event can never blank the whole conversation via the error boundary. Kept local to
 * avoid dragging the OpenAPI snapshot into the webview bundle.
 */
function asPermission(raw: unknown): PermissionRequest | undefined {
  const d = raw as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  const id = str(d, "id");
  const sessionID = str(d, "sessionID");
  if (!id || !sessionID) return undefined;
  return {
    ...(d as unknown as PermissionRequest),
    id,
    sessionID,
    action: str(d, "action"),
    resources: Array.isArray(d.resources) ? d.resources.filter((r): r is string => typeof r === "string") : [],
    save: Array.isArray(d.save) ? d.save.filter((s): s is string => typeof s === "string") : [],
  };
}

function asForm(raw: unknown): FormRequest | undefined {
  const d = raw as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  const id = str(d, "id");
  const sessionID = str(d, "sessionID");
  if (!id || !sessionID) return undefined;
  return {
    ...(d as unknown as FormRequest),
    id,
    sessionID,
    title: str(d, "title"),
    fields: Array.isArray(d.fields)
      ? (d.fields as FormRequest["fields"]).filter((f) => !!f && typeof f.key === "string")
      : [],
  };
}

export function eventSessionId(event: ServerEvent): string | undefined {
  const d = event.data as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  if (typeof d.sessionID === "string") return d.sessionID;
  const form = d.form as Data | undefined;
  if (form && typeof form.sessionID === "string") return form.sessionID;
  return undefined;
}

function updateAssistant(
  state: ChatState,
  id: string,
  update: (m: UiAssistantMessage) => UiAssistantMessage,
  create?: () => UiAssistantMessage,
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx === -1) {
    const fresh = create
      ? create()
      : ({ kind: "assistant", id, created: Date.now(), agent: "", parts: [], done: false } as UiAssistantMessage);
    return { ...state, messages: insertSorted(state.messages, update(fresh)) };
  }
  const existing = state.messages[idx];
  if (existing.kind !== "assistant") return state;
  const messages = state.messages.slice();
  messages[idx] = update(existing);
  return { ...state, messages };
}

function insertSorted(list: UiMessage[], msg: UiMessage): UiMessage[] {
  let i = list.length;
  // Keep arrival order for equal timestamps: the live stream has no replay, and events that land
  // in the same millisecond must stay in the order the server produced them (prompt history etc.).
  while (i > 0 && list[i - 1].created > msg.created) i--;
  const copy = list.slice();
  copy.splice(i, 0, msg);
  return copy;
}

function updatePart(
  m: UiAssistantMessage,
  key: string,
  update: (p: UiPart | undefined) => UiPart,
): UiAssistantMessage {
  const idx = m.parts.findIndex((p) => p.key === key);
  const parts = m.parts.slice();
  if (idx === -1) parts.push(update(undefined));
  else parts[idx] = update(parts[idx]);
  return { ...m, parts };
}

function textPart(kind: "text" | "reasoning", key: string, p: UiPart | undefined): TextPart {
  return p && p.kind === kind ? p : { kind, key, text: "", done: false };
}

function toolPart(id: string, p: UiPart | undefined): ToolPart {
  return p && p.kind === "tool"
    ? p
    : { kind: "tool", key: `tool:${id}`, id, name: "tool", status: "streaming", inputText: "", output: [] };
}

/** Events that mutate an assistant part. Without a message id they would create a phantom card. */
const ASSISTANT_PART_EVENTS = new Set([
  "session.step.started",
  "session.text.started",
  "session.reasoning.started",
  "session.text.delta",
  "session.reasoning.delta",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
]);

export function applyEvent(state: ChatState, event: ServerEvent): ChatState {
  const d = (event.data ?? {}) as Data;
  const sid = eventSessionId(event);
  if (state.sessionId === null || sid !== state.sessionId) return state;
  const created = event.created ?? Date.now();
  const msgId = str(d, "assistantMessageID");
  if (!msgId && ASSISTANT_PART_EVENTS.has(event.type)) return state;

  switch (event.type) {
    case "session.inbox.enqueued": {
      const item = d.item as {
        type?: string;
        payload?: { text?: string; files?: { uri?: string; name?: string; source?: { uri?: string } }[] };
      };
      if (item?.type === "synthetic") {
        const parsed = parseSubagentReport(item.payload?.text);
        if (parsed) {
          return { ...state, subagentReports: { ...(state.subagentReports ?? {}), [parsed.sessionId]: parsed.report } };
        }
        return state;
      }
      if (item?.type !== "user") return state;
      const id = str(d, "inboxID");
      if (state.messages.some((m) => m.id === id)) return state;
      const msg: UiUserMessage = {
        kind: "user",
        id,
        created,
        text: item.payload?.text ?? "",
        // Attachments delivered by the live stream carry their location in `source`, like history.
        files: (item.payload?.files ?? [])
          .map((f) => ({ uri: f.uri ?? f.source?.uri ?? "", name: f.name }))
          .filter((f) => f.uri || f.name),
      };
      return { ...state, messages: insertSorted(state.messages, msg), turns: openTurn(state, id, created) };
    }
    case "session.inbox.cancelled": {
      const id = str(d, "inboxID");
      return { ...state, messages: state.messages.filter((m) => m.id !== id), turns: state.turns.filter((t) => t.id !== id) };
    }
    case "session.execution.started": {
      // Events can be missed when connecting mid-turn, so always have a turn to attach usage to.
      const turns = state.turns.some((t) => t.ended === undefined)
        ? state.turns
        : [...state.turns, { id: `turn-${created}`, started: created }];
      return { ...state, busy: true, lastError: undefined, retry: undefined, turns };
    }
    case "session.status": {
      const status = d.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined;
      if (status?.type === "retry") {
        return {
          ...state,
          busy: true,
          retry: { attempt: status.attempt ?? 0, message: status.message ?? "", next: status.next },
        };
      }
      const busy = status?.type === "busy";
      // Reattaching mid-turn can deliver `busy` without `execution.started`. Open a turn here too,
      // otherwise `step.ended` has nowhere to put tokens/cost and silently drops them.
      const turns = busy && !state.turns.some((t) => t.ended === undefined)
        ? [...state.turns, { id: `turn-${created}`, started: created }]
        : state.turns;
      return { ...state, busy, retry: undefined, turns };
    }
    case "session.step.started":
      return updateAssistant(
        state,
        msgId,
        (m) => ({ ...m, agent: str(d, "agent") || m.agent, model: (d.model as ModelRef) ?? m.model, done: false }),
        () => ({ kind: "assistant", id: msgId, created, agent: str(d, "agent"), parts: [], done: false }),
      );
    case "session.text.started":
    case "session.reasoning.started": {
      const kind = event.type === "session.text.started" ? "text" : "reasoning";
      const key = `${kind}:${String(d.ordinal ?? 0)}`;
      return updateAssistant(state, msgId, (m) => updatePart(m, key, (p) => textPart(kind, key, p)));
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const kind = event.type === "session.text.delta" ? "text" : "reasoning";
      const key = `${kind}:${String(d.ordinal ?? 0)}`;
      const delta = str(d, "delta");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, key, (p) => {
          const t = textPart(kind, key, p);
          return { ...t, text: t.text + delta };
        }),
      );
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = event.type === "session.text.ended" ? "text" : "reasoning";
      const key = `${kind}:${String(d.ordinal ?? 0)}`;
      const text = str(d, "text");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, key, (p) => ({ ...textPart(kind, key, p), text, done: true })),
      );
    }
    case "session.tool.input.started": {
      const id = str(d, "id");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => ({ ...toolPart(id, p), name: str(d, "name") || "tool" })),
      );
    }
    case "session.tool.input.delta": {
      const id = str(d, "id");
      const delta = str(d, "delta");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => {
          const t = toolPart(id, p);
          return { ...t, inputText: t.inputText + delta };
        }),
      );
    }
    case "session.tool.input.ended": {
      const id = str(d, "id");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => ({ ...toolPart(id, p), inputText: str(d, "text") })),
      );
    }
    case "session.tool.called": {
      const id = str(d, "id");
      const input = (d.input as Record<string, unknown>) ?? {};
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => ({
          ...toolPart(id, p),
          input,
          inputText: JSON.stringify(input, null, 2),
          status: "running",
        })),
      );
    }
    case "session.tool.progress": {
      const id = str(d, "id");
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => {
          const t = toolPart(id, p);
          return { ...t, metadata: { ...(t.metadata ?? {}), ...((d.metadata as Data) ?? {}) } };
        }),
      );
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const id = str(d, "id");
      const failed = event.type === "session.tool.failed";
      return updateAssistant(state, msgId, (m) =>
        updatePart(m, `tool:${id}`, (p) => {
          const t = toolPart(id, p);
          return {
            ...t,
            status: failed ? "error" : "completed",
            output: (d.content as ToolContent[]) ?? [],
            metadata: { ...(t.metadata ?? {}), ...((d.metadata as Data) ?? {}) },
            error: failed ? (d.error as StructuredError) : undefined,
          };
        }),
      );
    }
    case "session.step.ended": {
      const tokens = d.tokens as TokenUsage | undefined;
      const withMessage = updateAssistant({ ...state, contextTokens: contextTokensOf(tokens) ?? state.contextTokens }, msgId, (m) => ({
        ...m,
        done: true,
        finish: str(d, "finish") || m.finish,
        retry: undefined,
        parts: m.parts.map((p) => (p.kind === "tool" || p.done ? p : { ...p, done: true })),
      }));
      const withTurns: ChatState = {
        ...withMessage,
        turns: withOpenTurn(state, (t) => ({
          ...t,
          tokens: addTokens(t.tokens, tokens),
          cost: typeof d.cost === "number" ? (t.cost ?? 0) + d.cost : t.cost,
        })),
      };
      return withTouchedFiles(withTurns, d.files);
    }
    case "session.step.failed": {
      const error = d.error as StructuredError | undefined;
      return withTouchedFiles(updateAssistant(state, msgId, (m) => ({
        ...m,
        done: true,
        retry: undefined,
        error: error && error.type !== "aborted" ? error : m.error,
        parts: m.parts.map((p) =>
          p.kind === "tool"
            ? p.status === "streaming" || p.status === "running"
              ? { ...p, status: "error", error: error ?? { type: "aborted", message: "" } }
              : p
            : { ...p, done: true },
        ),
      })), d.files);
    }
    case "session.retry.scheduled": {
      const error = d.error as StructuredError | undefined;
      return updateAssistant(state, msgId, (m) => ({
        ...m,
        retry: { attempt: Number(d.attempt ?? 0), message: error?.message ?? "" },
      }));
    }
    case "session.execution.succeeded":
      return { ...finishAll(state), busy: false, retry: undefined, turns: endTurn(state, created) };
    case "session.execution.failed": {
      const error = (d.error as StructuredError) ?? { type: "unknown", message: "" };
      const s = finishAll(state);
      return {
        ...s,
        busy: false,
        retry: undefined,
        lastError: error,
        turns: endTurn(state, created),
        messages: [...s.messages, notice(event.id ?? `err-${created}`, created, "error", "failed", error.message)],
      };
    }
    case "session.execution.interrupted": {
      const s = finishAll(state);
      return {
        ...s,
        busy: false,
        retry: undefined,
        turns: endTurn(state, created),
        messages: [...s.messages, notice(event.id ?? `int-${created}`, created, "warning", "interrupted", str(d, "reason"))],
      };
    }
    case "session.usage.updated": {
      // A malformed/truncated event must not erase valid token counts or write `undefined` into
      // state (the composer treats a present `usage` as authoritative). Keep the previous value.
      const tokens = d.tokens as TokenUsage | undefined;
      if (!tokens || typeof tokens.input !== "number" || typeof tokens.output !== "number") return state;
      return { ...state, usage: { cost: Number(d.cost ?? 0), tokens } };
    }
    case "session.renamed":
      return { ...state, title: str(d, "title") };
    case "session.agent.selected":
      return { ...state, agent: str(d, "agent") };
    case "session.model.selected": {
      // Ignore shape drift instead of overwriting a valid selection with `undefined`.
      const model = d.model as ModelRef | undefined;
      if (!model || typeof model.id !== "string" || typeof model.providerID !== "string") return state;
      return { ...state, model };
    }
    case "session.compaction.ended":
      return { ...state, contextTokens: undefined, messages: [...state.messages, notice(event.id ?? `cmp-${created}`, created, "info", "compaction", "")] };
    case "permission.asked": {
      const req = asPermission(d);
      if (!req || state.permissions.some((p) => p.id === req.id)) return state;
      return { ...state, permissions: [...state.permissions, req] };
    }
    case "permission.replied": {
      const id = str(d, "requestID");
      return { ...state, permissions: state.permissions.filter((p) => p.id !== id) };
    }
    case "form.created": {
      const form = asForm(d.form);
      if (!form || state.forms.some((f) => f.id === form.id)) return state;
      return { ...state, forms: [...state.forms, form] };
    }
    case "form.replied": {
      const id = str(d, "id");
      return { ...state, forms: state.forms.filter((f) => f.id !== id) };
    }
    case "form.cancelled": {
      const id = str(d, "id");
      // Dismissing a question ends the assistant's step. The server may not follow with a
      // terminal execution event, so settle the turn and unlock the composer here as well
      // (defence in depth with the controller's local idle status).
      const s = finishAll(state);
      return { ...s, forms: s.forms.filter((f) => f.id !== id), busy: false, retry: undefined };
    }
    default:
      return state;
  }
}

function finishAll(state: ChatState): ChatState {
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.kind !== "assistant" || m.done) return m;
    changed = true;
    return { ...m, done: true };
  });
  return changed ? { ...state, messages } : state;
}

// ---- selectors ---------------------------------------------------------------------------

const TODO_TOOL_RE = /todo/i;

/** Latest todo list written by the `todowrite` tool (experimental in OpenCode 2.2). */
export function selectTodos(state: ChatState): Todo[] | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.kind !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.kind !== "tool" || !TODO_TOOL_RE.test(p.name)) continue;
      const todos = (p.metadata?.todos ?? p.input?.todos) as unknown;
      if (Array.isArray(todos)) {
        return todos
          .filter((t): t is Todo => !!t && typeof t === "object" && typeof (t as Todo).content === "string")
          .map((t) => ({ content: t.content, status: String(t.status ?? "pending") }));
      }
    }
  }
  return undefined;
}

export interface ChangedFile {
  file: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
}

/**
 * Files changed by completed tools in this conversation, reconstructed from `metadata.files`.
 * This is the fallback for `GET /session/{id}/diff`, which is empty outside git repositories.
 */
export function selectToolChangedFiles(state: ChatState): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  for (const m of state.messages) {
    if (m.kind !== "assistant") continue;
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.status !== "completed") continue;
      for (const f of selectToolFiles(p)) {
        const status: FileDiff["status"] = f.status === "added" || f.status === "deleted" ? f.status : "modified";
        byFile.set(f.file, {
          file: f.file,
          patch: f.patch,
          status,
          additions: Number(f.additions) || 0,
          deletions: Number(f.deletions) || 0,
        });
      }
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Upper bound on remembered step paths; an unbounded list grows for the whole session lifetime. */
const MAX_TOUCHED_FILES = 500;

function withTouchedFiles(state: ChatState, files: unknown): ChatState {
  const paths = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  if (paths.length === 0) return state;
  const known = new Set(state.touchedFiles ?? []);
  let added = false;
  for (const p of paths) {
    if (!known.has(p)) {
      known.add(p);
      added = true;
    }
  }
  if (!added) return state;
  const all = [...known];
  return { ...state, touchedFiles: all.length > MAX_TOUCHED_FILES ? all.slice(-MAX_TOUCHED_FILES) : all };
}

/** `/diff` data (when available) is authoritative; tool metadata and step paths fill the gaps. */
export function mergeChangedFiles(fromDiff: FileDiff[], state: ChatState): FileDiff[] {
  const merged = new Map<string, FileDiff>();
  // Lowest priority: a step tells us a file was touched, but not how (no patch, no counts).
  for (const file of state.touchedFiles ?? []) {
    merged.set(file, { file, patch: "", additions: 0, deletions: 0, status: "modified" });
  }
  for (const f of selectToolChangedFiles(state)) merged.set(f.file, f);
  for (const f of fromDiff) merged.set(f.file, f);
  return [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Files touched by tools in this conversation (from `metadata.files`), latest patch per file. */
export function selectToolFiles(part: ToolPart): ChangedFile[] {
  const files = part.metadata?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (f): f is ChangedFile => !!f && typeof f === "object" && typeof (f as ChangedFile).file === "string" && typeof (f as ChangedFile).patch === "string",
  );
}

export function permissionsForTool(state: ChatState, toolId: string): PermissionRequest[] {
  return state.permissions.filter((p) => p.source?.id === toolId);
}

export function orphanPermissions(state: ChatState): PermissionRequest[] {
  const toolIds = new Set<string>();
  for (const m of state.messages) {
    if (m.kind === "assistant") for (const p of m.parts) if (p.kind === "tool") toolIds.add(p.id);
  }
  return state.permissions.filter((p) => !p.source || !toolIds.has(p.source.id));
}

export function formsForTool(state: ChatState, toolId: string): FormRequest[] {
  return state.forms.filter((f) => (f.metadata?.tool as { id?: string } | undefined)?.id === toolId);
}

export function orphanForms(state: ChatState): FormRequest[] {
  const toolIds = new Set<string>();
  for (const m of state.messages) {
    if (m.kind === "assistant") for (const p of m.parts) if (p.kind === "tool") toolIds.add(p.id);
  }
  return state.forms.filter((f) => {
    const id = (f.metadata?.tool as { id?: string } | undefined)?.id;
    return !id || !toolIds.has(id);
  });
}

/** Both orphan scans in one pass over the conversation (the webview needs them on every render). */
export function orphanCards(state: ChatState): { permissions: PermissionRequest[]; forms: FormRequest[] } {
  const toolIds = new Set<string>();
  for (const m of state.messages) {
    if (m.kind === "assistant") for (const p of m.parts) if (p.kind === "tool") toolIds.add(p.id);
  }
  return {
    permissions: state.permissions.filter((p) => !p.source || !toolIds.has(p.source.id)),
    forms: state.forms.filter((f) => {
      const id = (f.metadata?.tool as { id?: string } | undefined)?.id;
      return !id || !toolIds.has(id);
    }),
  };
}
