import type { SessionInfo, SessionMessage } from "../api";
import { parseBackgroundResult } from "../backgroundResult";
import type { SessionSummary } from "../protocol";

export function isIncomplete(m: SessionMessage): boolean {
  return m.type === "assistant" && m.time.completed === undefined;
}

/**
 * A message that ends a turn regardless of what the host's busy/idle timestamps say.
 *
 * Besides the normal `idle` marker, a server can end an interrupted turn with only a completed
 * assistant message carrying an `aborted` error (observed when the location shut down mid-turn:
 * `time.busy` was left set and no `time.idle` / `idle` message was ever written).
 */
export function isTerminalMessage(m: SessionMessage | undefined): boolean {
  if (m?.type === "idle") return true;
  return m !== undefined && m.type === "assistant" && m.time.completed !== undefined && m.error?.type === "aborted";
}

/** Outcome of the last turn, derived from the session history. Timestamps are only a fallback. */
export type SessionTurnStatus = "running" | "idle" | "failed" | "interrupted";

/**
 * Classifies the last turn of a session from its history.
 *
 * An `idle` message is authoritative through its outcome. Without one, an unfinished assistant
 * message means the turn is still streaming, and a completed assistant message carrying an error
 * ends the turn as failed (or interrupted for `aborted`). Bookkeeping messages (compaction,
 * notices, …) are ignored so they cannot hide the terminal message. A plain completed assistant
 * message is not enough to call the turn idle: a multi-step turn has one between each step, which
 * is why the timestamp fallback stays in place there.
 */
export function sessionTurnStatus(time: SessionInfo["time"], messages?: SessionMessage[]): SessionTurnStatus {
  if (!messages) return sessionLooksBusy(time) ? "running" : "idle";
  let last: SessionMessage | undefined;
  for (const m of messages) {
    if (m.type === "user" || m.type === "assistant" || m.type === "idle") last = m;
  }
  if (last?.type === "idle") {
    if (last.outcome === "failed" || last.outcome === "interrupted") return last.outcome;
    return "idle";
  }
  if (last?.type === "assistant") {
    if (last.time.completed === undefined) return "running";
    if (last.error) return last.error.type === "aborted" ? "interrupted" : "failed";
  }
  return sessionLooksBusy(time) ? "running" : "idle";
}

/**
 * Whether a session still has an execution running.
 *
 * `time.busy` / `time.idle` are the timestamps of the last transitions to busy and idle. The
 * real server can leave them inconsistent right after an interrupt (an interrupted session has
 * been observed with `busy` newer than `idle`), which makes a naive comparison report the
 * session as busy forever. A terminal message in the history (an `idle` marker or an aborted
 * assistant message) is authoritative: once it is present, the turn is over, regardless of what
 * the timestamps say.
 */
export function sessionIsBusy(time: SessionInfo["time"], messages: SessionMessage[]): boolean {
  // Ignore trailing bookkeeping messages (e.g. compaction) and look at the last turn event.
  let last: SessionMessage | undefined;
  for (const m of messages) {
    if (m.type === "user" || m.type === "assistant" || m.type === "idle") last = m;
  }
  if (isTerminalMessage(last)) return false;
  return sessionLooksBusy(time);
}

/** Cheap timestamp-only check, for when the session history is not available. */
export function sessionLooksBusy(time: SessionInfo["time"]): boolean {
  return (time.busy ?? 0) > (time.idle ?? 0);
}

/**
 * Whether a session has a shell command still running in the background. The turn that started it
 * is already idle, so the busy timestamp is settled: the only trace is a `shell` tool called with
 * `background: true` whose shell id has no matching `<background-result>` in the history yet.
 */
export function sessionWaitingShell(messages?: SessionMessage[]): boolean {
  if (!messages) return false;
  const settled = new Set<string>();
  for (const m of messages) {
    if (m.type !== "synthetic") continue;
    const parsed = parseBackgroundResult(m.text, m.description);
    if (parsed?.id) settled.add(parsed.id);
  }
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const c of m.content) {
      if (c.type !== "tool" || c.name !== "shell") continue;
      const state = c.state;
      if (state.status === "streaming") continue;
      const content = "content" in state ? (state.content ?? []) : [];
      const backgrounded =
        state.input?.background === true ||
        content.some((c: { type: string; text?: string }) => c.type === "text" && /moved to the background/i.test(c.text ?? ""));
      if (!backgrounded) continue;
      const id = state.metadata?.shellID;
      if (typeof id === "string" && id && !settled.has(id)) return true;
    }
  }
  return false;
}

/**
 * Builds the list entry for a session. When a history is available, the last turn message is
 * authoritative: the timestamps alone can stay stale after an interrupt, which would otherwise
 * leave the session marked as running in the list even though the chat itself is idle.
 * `needsInput` is the exception: pending permissions and forms are not messages, so it comes from
 * the live endpoints in `SessionListService`.
 */
export function toSessionSummary(info: SessionInfo, messages?: SessionMessage[], needsInput = false): SessionSummary {
  const status = sessionTurnStatus(info.time, messages);
  return {
    id: info.id,
    title: info.title ?? "",
    updated: info.time.updated,
    busy: status === "running",
    waiting: sessionWaitingShell(messages),
    needsInput,
    ...(status === "failed" || status === "interrupted" ? { error: status } : {}),
  };
}
