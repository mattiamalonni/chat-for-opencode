import type { SessionInfo, SessionMessage } from "../api";
import type { SessionSummary } from "../protocol";

export function isIncomplete(m: SessionMessage): boolean {
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
