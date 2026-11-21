import { Generation } from "./generation";

/**
 * Owns the controller's in-flight invalidation tokens and deferred work.
 *
 * The controller used to declare five `Generation` counters and six timer fields side by side. Every
 * async path had to remember which counter and which timer it belonged to; forgetting one produced
 * the races that filled the changelog. Keeping them here gives every piece of deferred work one
 * name, one owner and one `clearAll()` path, so the controller can reason in terms of operations
 * ("schedule a sessions refresh") instead of timer handles.
 */
export type DeferredName = "sessions" | "changes" | "inbox" | "reconcile" | "catalogRetry" | "livePoll";

export class ChatLifecycle {
  readonly generations = {
    sessions: new Generation(),
    execution: new Generation(),
    load: new Generation(),
    connect: new Generation(),
    child: new Generation(),
  } as const;

  private readonly timeouts = new Map<Exclude<DeferredName, "livePoll">, NodeJS.Timeout>();
  private readonly intervals = new Map<"livePoll", NodeJS.Timeout>();

  /** (Re)schedule a one-shot task, cancelling any earlier task with the same name. */
  schedule(name: Exclude<DeferredName, "livePoll">, fn: () => void, ms: number): void {
    this.cancel(name);
    this.timeouts.set(name, setTimeout(fn, ms));
  }

  cancel(name: Exclude<DeferredName, "livePoll">): void {
    const timer = this.timeouts.get(name);
    if (timer) clearTimeout(timer);
    this.timeouts.delete(name);
  }

  /** Starts an interval if none is running; returns false when one was already active. */
  startInterval(name: "livePoll", fn: () => void, ms: number): boolean {
    if (this.intervals.has(name)) return false;
    this.intervals.set(name, setInterval(fn, ms));
    return true;
  }

  stopInterval(name: "livePoll"): void {
    const timer = this.intervals.get(name);
    if (timer) clearInterval(timer);
    this.intervals.delete(name);
  }

  hasInterval(name: "livePoll"): boolean {
    return this.intervals.has(name);
  }

  /** Cancel every deferred task. Used when the connection, folder or whole controller changes. */
  clearAll(): void {
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.timeouts.clear();
    this.intervals.clear();
  }
}
