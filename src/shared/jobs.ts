/**
 * Pending server jobs from `experimental.job.updated` (OpenCode 2.4.0). The generated client does
 * not expose the job endpoint, so the live event is the only source; a reconnect may therefore miss
 * jobs that started while disconnected. Job ids are stable across updates, which makes the event
 * safe to apply repeatedly after a resubscribe.
 */

export interface JobInfo {
  id: string;
  sessionID: string;
  kind: string;
  status: string;
  title?: string;
  command?: string;
  description?: string;
  childSessionID?: string;
  started: number;
}

export function parseJobInfo(raw: unknown): JobInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (typeof value.sessionID !== "string" || !value.sessionID) return undefined;
  const time = value.time && typeof value.time === "object" ? (value.time as Record<string, unknown>) : {};
  const optional = (key: string): string | undefined => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  return {
    id: value.id,
    sessionID: value.sessionID,
    kind: optional("kind") ?? "other",
    status: optional("status") ?? "running",
    title: optional("title"),
    command: optional("command"),
    description: optional("description"),
    childSessionID: optional("childSessionID"),
    started: typeof time.started === "number" ? time.started : 0,
  };
}

export function isPendingJob(job: JobInfo): boolean {
  return job.status === "running";
}

/** Human-readable one-liner for a pending job card. */
export function jobLabel(job: JobInfo): string {
  return job.title || job.command || job.description || job.kind;
}
