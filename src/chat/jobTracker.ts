import type { ServerEvent } from "../shared/api";
import { isPendingJob, parseJobInfo, type JobInfo } from "../shared/jobs";

/**
 * Host-side registry of running background jobs, fed live by `experimental.job.updated` and seeded
 * from `experimental.job.list` on connect and after a stream reconnect (see `replace`).
 */
export class JobTracker {
  private readonly byId = new Map<string, JobInfo>();
  private readonly listeners = new Set<() => void>();

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Applies one normalized event; returns true when the pending set changed. */
  observe(event: ServerEvent): boolean {
    if (event.type === "experimental.job.updated") {
      const info = parseJobInfo((event.data as { info?: unknown } | undefined)?.info);
      if (!info) return false;
      if (isPendingJob(info)) this.byId.set(info.id, info);
      else if (!this.byId.delete(info.id)) return false;
      this.emit();
      return true;
    }
    if (event.type === "session.deleted") {
      const sid = (event.data as { sessionID?: unknown } | undefined)?.sessionID;
      return typeof sid === "string" ? this.forgetSession(sid) : false;
    }
    return false;
  }

  pending(): JobInfo[] {
    return [...this.byId.values()].sort((a, b) => a.started - b.started);
  }

  pendingFor(sessionID: string): JobInfo[] {
    return this.pending().filter((job) => job.sessionID === sessionID);
  }

  forgetSession(sessionID: string): boolean {
    let changed = false;
    for (const [id, job] of this.byId) {
      if (job.sessionID === sessionID) changed = this.byId.delete(id) || changed;
    }
    if (changed) this.emit();
    return changed;
  }

  /**
   * Replaces the registry with the server's list of running jobs: jobs that started while the stream
   * was down appear, and jobs whose final update was missed disappear. Returns true when it changed.
   */
  replace(jobs: readonly JobInfo[]): boolean {
    const next = new Map(jobs.filter(isPendingJob).map((job) => [job.id, job] as const));
    const same = next.size === this.byId.size && [...next.keys()].every((id) => this.byId.has(id));
    this.byId.clear();
    for (const [id, job] of next) this.byId.set(id, job);
    if (same) return false;
    this.emit();
    return true;
  }

  /** Folder switch / reconnect: jobs belong to the old server and cannot be tracked here. */
  reset(): void {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
