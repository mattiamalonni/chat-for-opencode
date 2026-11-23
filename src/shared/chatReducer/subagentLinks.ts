import type { SessionMessage } from "../api";
import { parseSubagentReport } from "../subagentReport";
import type { ChatState, UiMessage } from "./types";

/** Background children announce their report inside a synthetic message after the parent turn. */
export function reportsFromHistory(messages: SessionMessage[]): Record<string, string> | undefined {
  const reports: Record<string, string> = {};
  for (const m of messages) {
    if (m.type !== "synthetic") continue;
    const parsed = parseSubagentReport((m as { text?: string; description?: string }).text ?? (m as { description?: string }).description);
    if (parsed) reports[parsed.sessionId] = parsed.report;
  }
  return Object.keys(reports).length > 0 ? reports : undefined;
}

/**
 * A running `subagent` tool has no child id in persisted history. When a resync replaces a live
 * message with its history version, carry the id linked from a snapshot over by tool id so the
 * "Open subagent conversation" action does not blink out and back in.
 */
export function carrySubagentLinks(previous: UiMessage | undefined, next: UiMessage): UiMessage {
  if (!previous || previous.kind !== "assistant" || next.kind !== "assistant") return next;
  const linked = new Map<string, string>();
  for (const p of previous.parts) {
    if (p.kind === "tool" && typeof p.metadata?.sessionID === "string") linked.set(p.id, p.metadata.sessionID);
  }
  if (linked.size === 0) return next;
  return {
    ...next,
    parts: next.parts.map((p) => {
      if (p.kind !== "tool" || (p.name !== "subagent" && p.name !== "task") || p.metadata?.sessionID) return p;
      const sessionID = linked.get(p.id);
      return sessionID ? { ...p, metadata: { ...(p.metadata ?? {}), sessionID } } : p;
    }),
  };
}

/** Apply an explicit link by tool id; remember it if the card has not been rendered yet. */
export function linkToolToSubagent(state: ChatState, toolId: string, sessionId: string): ChatState {
  let found = false;
  const messages = state.messages.map((m) => {
    if (m.kind !== "assistant") return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (p.kind !== "tool" || (p.name !== "subagent" && p.name !== "task")) return p;
        if (p.id !== toolId || p.metadata?.sessionID) return p;
        found = true;
        return { ...p, metadata: { ...(p.metadata ?? {}), sessionID: sessionId } };
      }),
    };
  });
  const pending = { ...(state.pendingSubagentLinks ?? {}) };
  if (found) delete pending[toolId];
  else pending[toolId] = sessionId;
  return { ...state, messages, pendingSubagentLinks: pending };
}

/** Consume remembered links when the tool card arrives later in the live stream or a resync. */
export function applyPendingSubagentLinks(state: ChatState): ChatState {
  const pending = state.pendingSubagentLinks;
  if (!pending || Object.keys(pending).length === 0) return state;
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.kind !== "assistant") return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (p.kind !== "tool" || (p.name !== "subagent" && p.name !== "task") || p.metadata?.sessionID) return p;
        const sessionId = pending[p.id];
        if (!sessionId) return p;
        changed = true;
        return { ...p, metadata: { ...(p.metadata ?? {}), sessionID: sessionId } };
      }),
    };
  });
  return changed ? { ...state, messages } : state;
}
