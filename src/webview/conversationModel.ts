import { toolOutputLabel } from "../shared/toolOutput";
import {
  selectTurnFileChanges,
  selectTurnFiles,
  type TextPart,
  type ToolPart,
  type TurnStats,
  type UiAssistantMessage,
  type UiMessage,
} from "../shared/chatReducer";

import { messageSearchText } from "./messages";

export type ConversationItem =
  | { kind: "message"; message: UiMessage }
  | { kind: "assistant"; key: string; message: UiAssistantMessage; parts: TextPart[]; grouped: boolean }
  | { kind: "tool"; key: string; part: ToolPart }
  | { kind: "tools"; key: string; parts: ToolPart[] }
  | { kind: "status"; key: string; message: UiAssistantMessage; typing: boolean }
  | { kind: "step"; key: string; index: number; lastIndex: number; details: ConversationItem[]; live: boolean }
  | { kind: "turnStats"; key: string; stats: TurnStats };

/** The summary of a turn is emitted once, after the last assistant message it produced. */
function statsForTurn(turns: TurnStats[], msgs: UiAssistantMessage[]): TurnStats | undefined {
  const first = msgs[0]?.created;
  if (first === undefined) return undefined;
  const matches = turns.filter((t) => t.ended !== undefined && t.started <= first && first <= t.ended);
  if (matches.length === 0) return undefined;
  // A reconcile can add a history turn covering the same window whose tool metadata omits the
  // file counts. Prefer the turn that kept the counts captured live; fall back to whatever the
  // current tool parts still report (e.g. a turn first seen mid-stream).
  const kept =
    [...matches].reverse().find((t) => (t.additions ?? 0) > 0 || (t.deletions ?? 0) > 0 || (t.files?.length ?? 0) > 0) ??
    matches[matches.length - 1];
  const derived = selectTurnFileChanges(msgs);
  const files = selectTurnFiles(msgs);
  return {
    ...kept,
    additions: Math.max(kept.additions ?? 0, derived.additions),
    deletions: Math.max(kept.deletions ?? 0, derived.deletions),
    files: kept.files?.length ? kept.files : files,
  };
}

type StepPiece = { kind: "prose" | "details"; item: ConversationItem };

/**
 * Splits one step into always-visible prose and collapsible thoughts/tools, keeping their real
 * order. The model usually thinks before it speaks, but a reasoning part can also arrive *after*
 * a text part in the same assistant message; grouping all thoughts first moves that late
 * thought above the sentence it followed (visible until the next part re-rendered the step).
 */
function splitStep(items: ConversationItem[]): StepPiece[] {
  const out: StepPiece[] = [];
  for (const it of items) {
    if (it.kind !== "assistant") {
      out.push({ kind: "details", item: it });
      continue;
    }
    let run: TextPart[] = [];
    let runKind: "text" | "reasoning" | undefined;
    let seq = 0;
    const flush = () => {
      if (run.length === 0) return;
      out.push({
        kind: runKind === "text" ? "prose" : "details",
        item: {
          ...it,
          key: `${it.key}:${runKind === "text" ? "text" : "thoughts"}:${seq++}`,
          parts: run,
        },
      });
      run = [];
    };
    for (const p of it.parts) {
      if (runKind !== undefined && runKind !== p.kind) flush();
      runKind = p.kind;
      run.push(p);
    }
    flush();
  }
  return out;
}

/**
 * Consecutive thoughts/tools collapse into one fold; prose breaks the run and stays where the
 * model produced it. This keeps the common "think then speak" order (details above the answer)
 * without reordering a thought that arrived after a sentence. The live step's fold stays expanded
 * while the turn streams; finished ones collapse.
 */
function stepBlocks(groups: ConversationItem[][], liveIndex: number, turnKey = ""): ConversationItem[] {
  const out: ConversationItem[] = [];
  let pending: ConversationItem[] = [];
  let pendingFrom = -1;
  let pendingTo = -1;
  let foldSeq = 0;

  const flushPending = () => {
    if (pendingFrom < 0) return;
    out.push({
      kind: "step",
      // `pendingFrom`/`pendingTo` restart at 0 for every turn: without the turn key, an override
      // made in one reply would silently drive the auto fold state of a later one.
      key: `steps:${turnKey}:${pendingFrom}:${pendingTo}:${foldSeq++}`,
      index: pendingFrom,
      lastIndex: pendingTo,
      details: pending,
      live: liveIndex >= pendingFrom && liveIndex <= pendingTo,
    });
    pending = [];
    pendingFrom = -1;
    pendingTo = -1;
  };

  for (let s = 0; s < groups.length; s++) {
    for (const piece of splitStep(groups[s])) {
      if (piece.kind === "details") {
        if (pendingFrom < 0) pendingFrom = s;
        pending.push(piece.item);
        pendingTo = s;
      } else {
        flushPending();
        out.push(piece.item);
      }
    }
  }
  // A trailing textless run (turn ended after tool calls) still needs a fold.
  flushPending();
  return out;
}

/**
 * Renders a turn in the order the model produced it. OpenCode emits one assistant message per step;
 * each becomes a block with its prose visible and its thoughts/tools in a dedicated collapsible.
 */
export function conversationItems(messages: UiMessage[], turns: TurnStats[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let turn: UiAssistantMessage[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;

    // One group per assistant message: OpenCode emits one message per step, so a group boundary
    // is a step boundary. Keeping the groups lets us fold past steps even while the turn streams.
    const groups: ConversationItem[][] = [];
    let stepItems: ConversationItem[] = [];
    let tools: ToolPart[] = [];
    let started = false;

    const flushTools = () => {
      if (tools.length === 0) return;
      if (tools.length === 1) stepItems.push({ kind: "tool", key: tools[0].key, part: tools[0] });
      else stepItems.push({ kind: "tools", key: `tools:${tools[0].key}`, parts: tools });
      tools = [];
      started = true;
    };

    for (const m of turn) {
      let texts: TextPart[] = [];
      const flushTexts = () => {
        if (texts.length === 0) return;
        stepItems.push({ kind: "assistant", key: `${m.id}:${texts[0].key}`, message: m, parts: texts, grouped: started });
        texts = [];
        started = true;
      };
      for (const p of m.parts) {
        if (p.kind === "tool") {
          flushTexts();
          tools.push(p);
        } else {
          flushTools();
          texts.push(p);
        }
      }
      flushTexts();
      // Close the step here instead of at the end of the turn: adjacent tool calls from two
      // different steps must not merge into one accordion.
      flushTools();
      groups.push(stepItems);
      stepItems = [];
    }

    // Retry/error feedback belongs to the turn, after whatever content it managed to produce.
    for (const m of turn) {
      if (m.retry || m.error) {
        groups[groups.length - 1].push({ kind: "status", key: `status:${m.id}`, message: m, typing: false });
      }
    }
    const last = turn.at(-1);
    if (last && !last.done && last.parts.length === 0) {
      groups[groups.length - 1].push({ kind: "status", key: `typing:${last.id}`, message: last, typing: true });
    }

    const stats = statsForTurn(turns, turn);
    // While the reply streams, its current step stays open so the work is visible. The moment the
    // turn ends, every fold closes — the answer itself is prose and stays on screen, while the
    // thoughts/tools of all steps, including the last one, are available on demand.
    const liveIndex = stats ? -1 : groups.length - 1;
    // The first assistant message id is stable for the whole turn, including while it streams.
    items.push(...stepBlocks(groups, liveIndex, turn[0]?.id));
    if (stats) items.push({ kind: "turnStats", key: `stats:${stats.id}`, stats });
    turn = [];
  };

  for (const m of messages) {
    if (m.kind === "assistant") {
      turn.push(m);
      continue;
    }
    flushTurn();
    items.push({ kind: "message", message: m });
  }
  flushTurn();
  return items;
}

/** Text of a rendered conversation item, for the header's filter. */
export function itemSearchText(item: ConversationItem): string {
  switch (item.kind) {
    case "message":
      return messageSearchText(item.message);
    case "assistant":
      return item.parts.map((p) => p.text).join(" ");
    case "tool":
      return [item.part.name, item.part.inputText, ...item.part.output.map((c) => toolOutputLabel(c))].join(" ");
    case "tools":
      return item.parts.map((p) => [p.name, p.inputText].join(" ")).join(" ");
    case "status":
      return [item.message.error?.message ?? "", item.message.retry?.message ?? ""].join(" ");
    case "step":
      return item.details.map(itemSearchText).join(" ");
    case "turnStats":
      return "";
  }
}
