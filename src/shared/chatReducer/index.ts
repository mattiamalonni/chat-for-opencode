import type { ChatAction, ChatState, ToolPart } from "./types";
import { appendDelta, coalesceDeltas, loadHistory } from "./history";
import { applyPendingSubagentLinks, linkToolToSubagent } from "./subagentLinks";
import { applyEvent } from "./events";

export * from "./types";
export { contextTokensOf, eventSessionId } from "./helpers";
export { sessionIsBusy, sessionLooksBusy, toSessionSummary } from "./sessionStatus";
export { applyEvent } from "./events";
export {
  formsForTool,
  mergeChangedFiles,
  orphanPermissions,
  permissionsForTool,
  selectToolChangedFiles,
  selectToolFiles,
  selectTodos,
  selectTurnFileChanges,
  selectTurnFiles,
} from "./selectors";

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "load": {
      const loaded = loadHistory(action, state);
      const cleared = loaded.sessionId !== state.sessionId ? { ...loaded, pendingSubagentLinks: {} } : loaded;
      return applyPendingSubagentLinks(cleared);
    }
    case "append":
      return state.sessionId === action.delta.sessionId ? appendDelta(state, action.delta) : state;
    case "event":
      return applyEvent(state, action.event);
    case "events":
      // A streaming frame carries many consecutive deltas for the same part. Applying each one
      // would scan and copy the whole message list over and over (O(events × history)). Deltas for
      // one part are pure string appends, so fold adjacent ones into a single event first.
      return coalesceDeltas(action.events).reduce(applyEvent, state);
    case "inbox": {
      // A reconnect can drop `inbox.delivered`/`inbox.cancelled`. Without the server's list the
      // queued prompt stays in the reducer, and the next `execution.started` delivers it a second
      // time. Treat the fetched inbox as authoritative for ids we are still waiting on.
      const ids = new Set(action.items.map((item) => item.id));
      const queued = state.queuedMessages ?? {};
      const queuedMessages = Object.fromEntries(Object.entries(queued).filter(([id]) => ids.has(id)));
      const queuedTurnIds = (state.queuedTurnIds ?? []).filter((id) => ids.has(id));
      if (
        Object.keys(queuedMessages).length === Object.keys(queued).length &&
        queuedTurnIds.length === (state.queuedTurnIds ?? []).length
      ) {
        return state;
      }
      const messages = state.messages.filter((m) => m.kind !== "user" || !queued[m.id] || ids.has(m.id));
      const removedTurnIds = new Set((state.queuedTurnIds ?? []).filter((id) => !ids.has(id)));
      const turns = state.turns.filter((t) => !removedTurnIds.has(t.id));
      return { ...state, queuedMessages, queuedTurnIds, messages, turns };
    }
    case "linkSubagent": {
      if (action.toolId) return linkToolToSubagent(state, action.toolId, action.sessionId);
      // OpenCode only writes `metadata.sessionID` into a completed tool's history. A child found
      // via `session.created`/the session list must still be reachable from its card, so link the
      // id to the newest unlinked subagent call. Prefer an exact description/title match; when
      // several children run at once that keeps each card on its own conversation.
      const candidates: Array<{ index: number; part: ToolPart }> = [];
      state.messages.forEach((m, mi) => {
        if (m.kind !== "assistant") return;
        m.parts.forEach((p, pi) => {
          if (p.kind !== "tool" || (p.name !== "subagent" && p.name !== "task")) return;
          if (p.metadata?.sessionID) return;
          candidates.push({ index: mi * 1000 + pi, part: p });
        });
      });
      candidates.sort((a, b) => b.index - a.index);
      const description = (p: ToolPart): string | undefined => {
        const value = p.input?.description;
        return typeof value === "string" && value.trim() ? value : undefined;
      };
      const target = candidates.find((c) => action.title && description(c.part) === action.title) ?? candidates[0];
      if (!target) return state;
      const messages = state.messages.map((m, mi) =>
        m.kind !== "assistant"
          ? m
          : {
              ...m,
              parts: m.parts.map((p, pi) =>
                mi * 1000 + pi === target.index && p.kind === "tool"
                  ? { ...p, metadata: { ...(p.metadata ?? {}), sessionID: action.sessionId } }
                  : p,
              ),
            },
      );
      return { ...state, messages };
    }
    case "clearError":
      return { ...state, lastError: undefined };
  }
}
