import type { SessionMessage, TokenUsage } from "../api";
import type { ChangedFile, ChatState, TurnStats, UiAssistantMessage } from "./types";
import { usableModel } from "./helpers";
import { selectTurnFiles } from "./selectors";

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addTokens(base: TokenUsage | undefined, extra: TokenUsage | undefined): TokenUsage | undefined {
  if (!extra) return base;
  const b = base ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    input: b.input + (extra.input || 0),
    output: b.output + (extra.output || 0),
    reasoning: b.reasoning + (extra.reasoning || 0),
    cache: { read: b.cache.read + (extra.cache?.read || 0), write: b.cache.write + (extra.cache?.write || 0) },
  };
}

/** Merges the files reported by one tool's metadata into a per-turn, deduplicated accumulator. */
function addFileChanges(acc: Map<string, ChangedFile>, metadata: unknown): void {
  if (!metadata || typeof metadata !== "object") return;
  const files = (metadata as { files?: unknown }).files;
  if (!Array.isArray(files)) return;
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const raw = f as Record<string, unknown>;
    const file = raw.file;
    if (typeof file !== "string") continue;
    const status = raw.status;
    acc.set(file, {
      file,
      patch: typeof raw.patch === "string" ? raw.patch : "",
      status: status === "added" || status === "deleted" ? status : "modified",
      additions: Number(raw.additions) || 0,
      deletions: Number(raw.deletions) || 0,
    });
  }
}

function setTurnFiles(turn: TurnStats | undefined, acc: Map<string, ChangedFile>): void {
  if (!turn || acc.size === 0) return;
  let additions = 0;
  let deletions = 0;
  for (const v of acc.values()) {
    additions += v.additions;
    deletions += v.deletions;
  }
  turn.additions = additions;
  turn.deletions = deletions;
  turn.files = [...acc.values()];
}

/**
 * Rebuilds one summary per turn from history. A user message opens a turn, the assistant
 * messages that follow are its steps, and an idle (or the next user message) closes it.
 */
export function turnsFromHistory(messages: SessionMessage[], alreadySorted = false, openLast = false): TurnStats[] {
  // Both callers pass an array they just sorted with the same comparator. Re-sorting would copy
  // and run O(n log n) comparisons a second time on every load and every resync.
  const sorted = alreadySorted ? messages : [...messages].sort((a, b) => a.time.created - b.time.created || cmp(a.id, b.id));
  const turns: TurnStats[] = [];
  let current: TurnStats | undefined;
  let currentFiles = new Map<string, ChangedFile>();
  let lastCompleted: number | undefined;
  for (const m of sorted) {
    if (m.type === "user") {
      if (current && current.ended === undefined) current.ended = m.time.created;
      setTurnFiles(current, currentFiles);
      current = { id: m.id, started: m.time.created };
      currentFiles = new Map();
      lastCompleted = undefined;
      turns.push(current);
    } else if (m.type === "assistant" && current) {
      current.tokens = addTokens(current.tokens, m.tokens);
      current.steps = (current.steps ?? 0) + 1;
      // First step wins: a later `/model` switch must not change the model the turn started with.
      if (!usableModel(current.model) && usableModel(m.model)) current.model = m.model;
      if (typeof m.cost === "number") current.cost = (current.cost ?? 0) + m.cost;
      if (m.time.completed !== undefined) lastCompleted = Math.max(lastCompleted ?? 0, m.time.completed);
      for (const c of m.content) {
        if (c.type === "tool" && c.state.status === "completed") addFileChanges(currentFiles, c.state.metadata);
      }
    } else if (m.type === "idle" && current) {
      current.ended = m.time.created;
      setTurnFiles(current, currentFiles);
      current = undefined;
    }
  }
  // The last turn may have no idle entry yet; the assistant's completion time is the next best end.
  // Not when the server still reports the session busy, though: between two steps every assistant
  // message is complete while the turn is very much running. Closing it here (which happens on a
  // session switch, a resync or a manual Sync) makes the webview treat the turn as finished: the
  // summary replaces the live step and every collapsible folds shut, even though the reply goes on.
  if (!openLast && current && current.ended === undefined && lastCompleted !== undefined) current.ended = lastCompleted;
  setTurnFiles(current, currentFiles);
  return turns.filter((t) => (t.ended !== undefined || openLast) && t.tokens !== undefined);
}

export function closeOpenTurns(turns: TurnStats[], ended: number): TurnStats[] {
  let changed = false;
  const out = turns.map((t) => {
    if (t.ended !== undefined) return t;
    changed = true;
    return { ...t, ended };
  });
  return changed ? out : turns;
}

export function openTurn(state: ChatState, id: string, started: number): TurnStats[] {
  return [...closeOpenTurns(state.turns, started), { id, started }];
}

export function withOpenTurn(state: ChatState, update: (t: TurnStats) => TurnStats): TurnStats[] {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    if (state.turns[i].ended === undefined) {
      const turns = state.turns.slice();
      turns[i] = update(turns[i]);
      return turns;
    }
  }
  return state.turns;
}

/**
 * Captures file-edit counts on the open turn from the live tool parts. They are stored on the
 * TurnStats so a later reconcile — which replaces live messages with server history that may omit
 * `metadata.files` — cannot wipe them. Never decreases a count already captured.
 */
export function withLiveFileChanges(state: ChatState): ChatState {
  const open = state.turns.find((t) => t.ended === undefined);
  if (!open) return state;
  const msgs = state.messages.filter((m): m is UiAssistantMessage => m.kind === "assistant" && m.created >= open.started);
  const files = selectTurnFiles(msgs);
  const derived = { additions: 0, deletions: 0 };
  for (const f of files) {
    derived.additions += Number(f.additions) || 0;
    derived.deletions += Number(f.deletions) || 0;
  }
  const additions = Math.max(open.additions ?? 0, derived.additions);
  const deletions = Math.max(open.deletions ?? 0, derived.deletions);
  // A resync may have replaced the live parts already; keep the files captured earlier in that case.
  const keptFiles = files.length > 0 ? files : open.files;
  if (additions === (open.additions ?? 0) && deletions === (open.deletions ?? 0) && keptFiles === open.files) return state;
  return { ...state, turns: withOpenTurn(state, (t) => ({ ...t, additions, deletions, files: keptFiles })) };
}

export function endTurn(state: ChatState, ended: number): TurnStats[] {
  return withOpenTurn(state, (t) => ({ ...t, ended }));
}

/** A resync tail is authoritative for the turns it contains; live-only turns stay untouched. */
export function mergeTurns(current: TurnStats[], incoming: TurnStats[]): TurnStats[] {
  if (incoming.length === 0) return current;
  const merged = current.slice();
  // Index by id once instead of scanning the whole list for every incoming turn (O(n·m) → O(n+m)).
  const indexById = new Map(merged.map((t, i) => [t.id, i] as const));
  for (const t of incoming) {
    const at = indexById.get(t.id);
    if (at === undefined) {
      indexById.set(t.id, merged.length);
      merged.push(t);
      continue;
    }
    // The tail wins for tokens/steps/end, but history often drops completed tools' `metadata.files`.
    // Keep the file counts captured live instead of replacing the whole turn with a stateless one.
    const previous = merged[at];
    const additions = Math.max(previous.additions ?? 0, t.additions ?? 0);
    const deletions = Math.max(previous.deletions ?? 0, t.deletions ?? 0);
    const files = t.files?.length ? t.files : previous.files;
    // A tail can start mid-turn and only see a later step's model; keep the first one we captured.
    const model = usableModel(previous.model) ? previous.model : t.model;
    merged[at] = additions || deletions || files?.length || model ? { ...t, additions, deletions, files, model } : t;
  }
  return merged;
}
