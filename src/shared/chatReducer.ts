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
import type { SessionSummary } from "./protocol";

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

export interface ChatState {
  sessionId: string | null;
  title?: string;
  messages: UiMessage[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  busy: boolean;
  retry?: { attempt: number; message: string; next?: number };
  lastError?: StructuredError;
  usage?: { cost: number; tokens: TokenUsage };
  /** Estimated tokens in the model context after the last step (undefined until known / after compaction). */
  contextTokens?: number;
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
  | { type: "event"; event: ServerEvent }
  | { type: "events"; events: ServerEvent[] }
  | { type: "clearError" };

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
  permissions: [],
  forms: [],
  busy: false,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "load":
      return loadHistory(action);
    case "event":
      return applyEvent(state, action.event);
    case "events":
      return action.events.reduce(applyEvent, state);
    case "clearError":
      return { ...state, lastError: undefined };
  }
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
  const last = sorted[sorted.length - 1];
  // A terminal idle message wins over a stale `busy` flag from the host (see sessionIsBusy).
  const busy = last?.type === "idle" ? false : (action.busy ?? (last !== undefined && isIncomplete(last)));
  return {
    sessionId: action.sessionId,
    title: action.title,
    agent: action.agent,
    model: action.model,
    messages,
    permissions: action.permissions,
    forms: action.forms,
    busy,
    contextTokens,
    usage: action.usage,
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

export function applyEvent(state: ChatState, event: ServerEvent): ChatState {
  const d = (event.data ?? {}) as Data;
  const sid = eventSessionId(event);
  if (state.sessionId === null || sid !== state.sessionId) return state;
  const created = event.created ?? Date.now();
  const msgId = str(d, "assistantMessageID");

  switch (event.type) {
    case "session.inbox.enqueued": {
      const item = d.item as {
        type?: string;
        payload?: { text?: string; files?: { uri?: string; name?: string; source?: { uri?: string } }[] };
      };
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
      return { ...state, messages: insertSorted(state.messages, msg) };
    }
    case "session.inbox.cancelled": {
      const id = str(d, "inboxID");
      return { ...state, messages: state.messages.filter((m) => m.id !== id) };
    }
    case "session.execution.started":
      return { ...state, busy: true, lastError: undefined, retry: undefined };
    case "session.status": {
      const status = d.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined;
      if (status?.type === "retry") {
        return {
          ...state,
          busy: true,
          retry: { attempt: status.attempt ?? 0, message: status.message ?? "", next: status.next },
        };
      }
      return { ...state, busy: status?.type === "busy", retry: undefined };
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
    case "session.step.ended":
      return updateAssistant({ ...state, contextTokens: contextTokensOf(d.tokens as TokenUsage | undefined) ?? state.contextTokens }, msgId, (m) => ({
        ...m,
        done: true,
        finish: str(d, "finish") || m.finish,
        retry: undefined,
        parts: m.parts.map((p) => (p.kind === "tool" || p.done ? p : { ...p, done: true })),
      }));
    case "session.step.failed": {
      const error = d.error as StructuredError | undefined;
      return updateAssistant(state, msgId, (m) => ({
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
      }));
    }
    case "session.retry.scheduled": {
      const error = d.error as StructuredError | undefined;
      return updateAssistant(state, msgId, (m) => ({
        ...m,
        retry: { attempt: Number(d.attempt ?? 0), message: error?.message ?? "" },
      }));
    }
    case "session.execution.succeeded":
      return { ...finishAll(state), busy: false, retry: undefined };
    case "session.execution.failed": {
      const error = (d.error as StructuredError) ?? { type: "unknown", message: "" };
      const s = finishAll(state);
      return {
        ...s,
        busy: false,
        retry: undefined,
        lastError: error,
        messages: [...s.messages, notice(event.id ?? `err-${created}`, created, "error", "failed", error.message)],
      };
    }
    case "session.execution.interrupted": {
      const s = finishAll(state);
      return {
        ...s,
        busy: false,
        retry: undefined,
        messages: [...s.messages, notice(event.id ?? `int-${created}`, created, "warning", "interrupted", str(d, "reason"))],
      };
    }
    case "session.usage.updated":
      return { ...state, usage: { cost: Number(d.cost ?? 0), tokens: d.tokens as TokenUsage } };
    case "session.renamed":
      return { ...state, title: str(d, "title") };
    case "session.agent.selected":
      return { ...state, agent: str(d, "agent") };
    case "session.model.selected":
      return { ...state, model: d.model as ModelRef };
    case "session.compaction.ended":
      return { ...state, contextTokens: undefined, messages: [...state.messages, notice(event.id ?? `cmp-${created}`, created, "info", "compaction", "")] };
    case "permission.asked": {
      const req = d as unknown as PermissionRequest;
      if (state.permissions.some((p) => p.id === req.id)) return state;
      return { ...state, permissions: [...state.permissions, req] };
    }
    case "permission.replied": {
      const id = str(d, "requestID");
      return { ...state, permissions: state.permissions.filter((p) => p.id !== id) };
    }
    case "form.created": {
      const form = d.form as FormRequest;
      if (state.forms.some((f) => f.id === form.id)) return state;
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

/** Latest todo list written by the `todowrite` tool (experimental in OpenCode 2.2). */
export function selectTodos(state: ChatState): Todo[] | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.kind !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.kind !== "tool" || !/todo/i.test(p.name)) continue;
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

/** `/diff` data (when available) is authoritative; tool metadata fills the gaps. */
export function mergeChangedFiles(fromDiff: FileDiff[], state: ChatState): FileDiff[] {
  const merged = new Map<string, FileDiff>();
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
