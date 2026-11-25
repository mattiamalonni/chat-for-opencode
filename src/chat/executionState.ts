/**
 * The single owner of "is a turn running?" on the host side.
 *
 * A single `ExecutionStateService` owns `executionState`, the local-idle override and the execution
 * generation side by side, with each async path responsible for updating all three. That produced
 * status bars stuck on "running" and composers that re-locked after a resync. Everything about a
 * turn's lifecycle lives here: the status, the invalidation token, the local-idle grace period
 * and the listener fan-out. Both the status bar (`onDidChange`) and the controller's reconciler read
 * this one source of truth.
 */
import { Generation } from "./generation";

export type ExecutionStatus = "idle" | "running" | "needsInput" | "succeeded" | "failed" | "interrupted";

export interface ExecutionState {
  status: ExecutionStatus;
  sessionId?: string;
}

export type TerminalStatus = Extract<ExecutionStatus, "succeeded" | "failed" | "interrupted">;

export interface ExecutionSubscription {
  dispose(): void;
}

const TERMINAL_EVENTS: Record<string, TerminalStatus> = {
  "session.execution.succeeded": "succeeded",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
};

export class ExecutionStateService {
  /** Turn token, also used by the controller to guard reconciliation and deferred replies. */
  readonly generation = new Generation();

  private status: ExecutionStatus = "idle";
  private sessionId: string | undefined;
  private localIdle: { sid: string; generation: number } | undefined;
  private readonly listeners = new Set<(state: ExecutionState) => void>();

  onDidChange(listener: (state: ExecutionState) => void): ExecutionSubscription {
    this.listeners.add(listener);
    listener(this.state);
    return { dispose: () => this.listeners.delete(listener) };
  }

  get state(): ExecutionState {
    return { status: this.status, sessionId: this.sessionId };
  }

  publish(status: ExecutionStatus, sid: string | undefined = this.sessionId): void {
    this.status = status;
    this.sessionId = sid;
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  is(token: number): boolean {
    return this.generation.is(token);
  }

  current(): number {
    return this.generation.current();
  }

  /** Start an optimistic turn: invalidate older work and publish "running". */
  start(sid?: string): number {
    const token = this.generation.bump();
    this.localIdle = undefined;
    this.publish("running", sid);
    return token;
  }

  /**
   * Apply a normalized server event for the open session. Returns the terminal status when this
   * event ends a turn, so the caller can schedule reconciliation and notifications exactly once.
   */
  observe(type: string, sid: string | undefined, openSessionId: string | undefined): TerminalStatus | undefined {
    if (!sid || sid !== openSessionId) return undefined;
    if (type === "session.inbox.enqueued") {
      // A queued prompt opens a turn later; only invalidate the previous turn's deferred work.
      this.generation.bump();
      this.localIdle = undefined;
      return undefined;
    }
    if (type === "session.execution.started") {
      this.generation.bump();
      this.localIdle = undefined;
      this.publish("running", sid);
      return undefined;
    }
    // A pending approval/question is not "working": the status bar must say it is waiting on the
    // user, and clicking it must jump to the request instead of stopping the turn.
    if (type === "permission.asked" || type === "form.created") {
      if (this.status === "running" || this.status === "needsInput") this.publish("needsInput", sid);
      return undefined;
    }
    if (type === "permission.replied" || type === "form.replied" || type === "form.cancelled") {
      if (this.status === "needsInput") this.publish("running", sid);
      return undefined;
    }
    const terminal = TERMINAL_EVENTS[type];
    if (!terminal) return undefined;
    this.publish(terminal, sid);
    return terminal;
  }

  /** Close a turn that never reached the server; a newer turn must not be overwritten. */
  fail(sid: string | undefined, token: number | undefined): void {
    if (token !== undefined && this.is(token)) this.publish("failed", sid);
  }

  /**
   * Record a locally-posted idle (interrupt/cancel/dismissed question) and remember its token so a
   * resync does not re-lock the composer with stale server timestamps.
   */
  markLocalIdle(sid: string, token: number): boolean {
    if (!this.is(token)) return false;
    this.localIdle = { sid, generation: token };
    this.publish("idle", sid);
    return true;
  }

  isLocallyIdle(sid: string): boolean {
    return this.localIdle?.sid === sid && this.is(this.localIdle.generation);
  }

  /**
   * The open session changed. A turn belonging to the previous session cannot be closed by
   * its terminal events (they are filtered by session id), so end it here rather than leaving the
   * status bar spinning forever. No-op for a same-session resync.
   */
  ensureSession(sid?: string): void {
    if (this.sessionId === sid) return;
    this.generation.bump();
    this.localIdle = undefined;
    this.sessionId = sid;
    this.publish("idle", sid);
  }

  /** Folder switch / dispose: invalidate in-flight work and always close a stale running badge. */
  reset(sid?: string): void {
    this.generation.bump();
    this.localIdle = undefined;
    this.sessionId = sid;
    this.publish("idle", sid);
  }
}
