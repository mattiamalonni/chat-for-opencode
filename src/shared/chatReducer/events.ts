import type { ServerEvent, StructuredError, TokenUsage, ToolContent } from "../api";
import { parseBackgroundResult } from "../backgroundResult";
import { parseSubagentReport } from "../subagentReport";
import type { ChatState, TextPart, ToolPart, UiAssistantMessage, UiMessage, UiPart, UiUserMessage } from "./types";
import { asForm, asModelRef, asPermission, contextTokensOf, eventSessionId, str, usableModel, type Data } from "./helpers";
import { addTokens, closeOpenTurns, endTurn, openTurn, withLiveFileChanges, withOpenTurn } from "./turns";
import { applyPendingSubagentLinks } from "./subagentLinks";
import { withTouchedFiles } from "./selectors";
import { backgroundNotice, notice } from "./history";

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

/** Move a queued prompt into the conversation once the server actually delivers it. */
function deliverQueued(state: ChatState, id: string): ChatState {
  const pending = state.queuedMessages?.[id];
  if (!pending) return state;
  const queuedMessages = { ...state.queuedMessages };
  delete queuedMessages[id];
  return { ...state, messages: insertSorted(state.messages, pending), queuedMessages };
}

function updatePart(m: UiAssistantMessage, key: string, update: (p: UiPart | undefined) => UiPart): UiAssistantMessage {
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
  return p && p.kind === "tool" ? p : { kind: "tool", key: `tool:${id}`, id, name: "tool", status: "streaming", inputText: "", output: [] };
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
        delivery?: string;
        payload?: { text?: string; description?: string; files?: { uri?: string; name?: string; source?: { uri?: string } }[] };
      };
      if (item?.type === "synthetic") {
        const parsed = parseSubagentReport(item.payload?.text);
        if (parsed) {
          return { ...state, subagentReports: { ...(state.subagentReports ?? {}), [parsed.sessionId]: parsed.report } };
        }
        // A background shell/script result wakes the session after its turn ended. Render it live
        // instead of dropping it, so the chat shows what the notification was about.
        const background = parseBackgroundResult(item.payload?.text, item.payload?.description);
        if (background) {
          return {
            ...state,
            messages: insertSorted(state.messages, backgroundNotice(event.id ?? `bg-${created}`, created, background)),
          };
        }
        return state;
      }
      if (item?.type !== "user") return state;
      const id = str(d, "inboxID");
      if (state.messages.some((m) => m.id === id) || state.queuedMessages?.[id]) return state;
      const msg: UiUserMessage = {
        kind: "user",
        id,
        created,
        text: item.payload?.text ?? "",
        // Attachments delivered by the live stream carry their location in `source`, like history.
        files: (item.payload?.files ?? []).map((f) => ({ uri: f.uri ?? f.source?.uri ?? "", name: f.name })).filter((f) => f.uri || f.name),
      };
      // A queued prompt is only accepted now, not sent: keep it in the inbox panel until the server
      // delivers it. Opening a turn here would also close the running one early, showing its summary
      // (cost + duration) while the reply is still streaming. Its turn starts at `execution.started`.
      const messages = insertSorted(state.messages, msg);
      return item.delivery === "queue"
        ? {
            ...state,
            queuedMessages: { ...state.queuedMessages, [id]: msg },
            // Queued prompts start in order; each `execution.started` consumes the next id.
            queuedTurnIds: [...(state.queuedTurnIds ?? []), id],
          }
        : { ...state, messages, turns: openTurn(state, id, created) };
    }
    case "session.inbox.delivered": {
      // The inbox item has now been handed to the agent: the prompt belongs in the conversation.
      return deliverQueued(state, str(d, "inboxID"));
    }
    case "session.inbox.cancelled": {
      const id = str(d, "inboxID");
      const queuedMessages = { ...state.queuedMessages };
      delete queuedMessages[id];
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== id),
        turns: state.turns.filter((t) => t.id !== id),
        queuedMessages,
        queuedTurnIds: (state.queuedTurnIds ?? []).filter((queued) => queued !== id),
      };
    }
    case "session.execution.started": {
      const [nextId, ...remaining] = state.queuedTurnIds ?? [];
      if (nextId) {
        // The queued prompt finally starts. Settle the previous turn (normally already closed by
        // its terminal event) and open the new one under the queued message's id. Deliver the prompt
        // here too, in case its `inbox.delivered` event was missed on a reconnect. Consume one id per
        // start: with a single id, the second prompt of a batch got a synthetic turn id and created
        // a duplicate turn on the next resync.
        const started = deliverQueued(state, nextId);
        const turns = [...closeOpenTurns(started.turns, created), { id: nextId, started: created }];
        return { ...started, busy: true, lastError: undefined, retry: undefined, queuedTurnIds: remaining, turns };
      }
      // Events can be missed when connecting mid-turn, so always have a turn to attach usage to.
      const turns = state.turns.some((t) => t.ended === undefined)
        ? state.turns
        : [...state.turns, { id: `turn-${created}`, started: created }];
      return { ...state, busy: true, lastError: undefined, retry: undefined, turns };
    }
    case "session.status": {
      const status = d.status as { type?: string; local?: boolean; attempt?: number; message?: string; next?: number } | undefined;
      if (status?.type === "retry") {
        return {
          ...state,
          busy: true,
          retry: { attempt: status.attempt ?? 0, message: status.message ?? "", next: status.next },
        };
      }
      if (status?.type === "idle" && status.local) {
        // A locally-posted idle (interrupt/cancel/dismissed question) has no server terminal event.
        // Close the partial assistant messages and the turn as well as the composer, otherwise the
        // card keeps shimmering and its copy button stays disabled until a manual sync.
        const finished = finishAll(state);
        return { ...finished, busy: false, retry: undefined, turns: endTurn(state, created) };
      }
      const busy = status?.type === "busy";
      // Reattaching mid-turn can deliver `busy` without `execution.started`. Open a turn here too,
      // otherwise `step.ended` has nowhere to put tokens/cost and silently drops them.
      const turns =
        busy && !state.turns.some((t) => t.ended === undefined)
          ? [...state.turns, { id: `turn-${created}`, started: created }]
          : state.turns;
      return { ...state, busy, retry: undefined, turns };
    }
    case "session.step.started": {
      // A step can be the first event seen when reattaching mid-turn; make sure it has a turn.
      const base: ChatState = state.turns.some((t) => t.ended === undefined)
        ? state
        : { ...state, turns: [...state.turns, { id: `turn-${created}`, started: created }] };
      const stepModel = asModelRef(d.model);
      const counted: ChatState = {
        ...base,
        turns: withOpenTurn(base, (t) => ({
          ...t,
          steps: (t.steps ?? 0) + 1,
          // First step wins, even if this turn was opened before the first event arrived.
          model: usableModel(t.model) ? t.model : usableModel(stepModel) ? stepModel : t.model,
        })),
      };
      return updateAssistant(
        counted,
        msgId,
        (m) => ({ ...m, agent: str(d, "agent") || m.agent, model: asModelRef(d.model) ?? m.model, done: false }),
        () => ({ kind: "assistant", id: msgId, created, agent: str(d, "agent"), parts: [], done: false }),
      );
    }
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
      return updateAssistant(state, msgId, (m) => updatePart(m, key, (p) => ({ ...textPart(kind, key, p), text, done: true })));
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
      return updateAssistant(state, msgId, (m) => updatePart(m, `tool:${id}`, (p) => ({ ...toolPart(id, p), inputText: str(d, "text") })));
    }
    case "session.tool.called": {
      const id = str(d, "id");
      const input = (d.input as Record<string, unknown>) ?? {};
      return applyPendingSubagentLinks(
        updateAssistant(state, msgId, (m) =>
          updatePart(m, `tool:${id}`, (p) => ({
            ...toolPart(id, p),
            input,
            inputText: JSON.stringify(input, null, 2),
            status: "running",
          })),
        ),
      );
    }
    case "session.tool.progress": {
      const id = str(d, "id");
      return applyPendingSubagentLinks(
        updateAssistant(state, msgId, (m) =>
          updatePart(m, `tool:${id}`, (p) => {
            const t = toolPart(id, p);
            return { ...t, metadata: { ...(t.metadata ?? {}), ...((d.metadata as Data) ?? {}) } };
          }),
        ),
      );
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const id = str(d, "id");
      const failed = event.type === "session.tool.failed";
      const updated = updateAssistant(state, msgId, (m) =>
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
      return withLiveFileChanges(applyPendingSubagentLinks(updated));
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
      return withTouchedFiles(
        updateAssistant(state, msgId, (m) => ({
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
        })),
        d.files,
      );
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
      const model = asModelRef(d.model);
      if (!model) return state;
      return { ...state, model };
    }
    case "session.compaction.ended":
      return {
        ...state,
        contextTokens: undefined,
        messages: [...state.messages, notice(event.id ?? `cmp-${created}`, created, "info", "compaction", "")],
      };
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
      return { ...s, forms: s.forms.filter((f) => f.id !== id), busy: false, retry: undefined, turns: endTurn(state, created) };
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
