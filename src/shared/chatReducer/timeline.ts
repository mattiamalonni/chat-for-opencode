import { contextTokensOf } from "./helpers";
import type { ChatState } from "./types";

/** One user turn, in the form needed by the in-chat timeline picker. */
export interface TimelineEntry {
  /** Id of the user message that opened the turn; the conversation reveals that exact card. */
  id: string;
  text: string;
  started: number;
  ended?: number;
  steps?: number;
  tokens?: number;
  cost?: number;
  /** Total file insertions + deletions reported in this turn. */
  changes?: number;
}

/**
 * Turn summaries are keyed by the user message that opened them, but live turns can use a synthetic
 * `turn-<time>` id. Only turns with a real prompt are navigable, newest first.
 */
export function sessionTimeline(state: ChatState): TimelineEntry[] {
  const prompts = new Map<string, string>();
  for (const m of state.messages) if (m.kind === "user") prompts.set(m.id, m.text);
  const entries: TimelineEntry[] = [];
  for (const turn of state.turns) {
    const text = prompts.get(turn.id);
    if (text === undefined) continue;
    entries.push({
      id: turn.id,
      text,
      started: turn.started,
      ended: turn.ended,
      steps: turn.steps,
      tokens: turn.tokens ? contextTokensOf(turn.tokens) : undefined,
      cost: turn.cost,
      changes: (turn.additions ?? 0) + (turn.deletions ?? 0),
    });
  }
  return entries.reverse();
}
