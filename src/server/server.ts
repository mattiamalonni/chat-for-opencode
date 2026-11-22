import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { ApiError, OpenCodeClient, type Connection } from "../client/http";
import { jitteredDelay } from "../shared/constants";
import { clearServerRecord, writeServerRecord } from "./orphans";
import { redactSecrets } from "./redact";

export type ServerErrorKind = "notInstalled" | "startFailed" | "unauthorized" | "unreachable";

export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
    /** Safe to show in the chat: a short diagnosis produced by this extension. */
    readonly detail?: string,
    /**
     * Raw (but redacted and length-capped) child-process output. Diagnostic only: the controller
     * writes it to the Output channel and never sends it to the webview.
     */
    readonly logDetail?: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

export type ServerState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "running"; conn: Connection; version?: string }
  | { status: "failed"; error: ServerError };

export interface ServerHandle {
  readonly folder: string;
  readonly managed: boolean;
  readonly state: ServerState;
  ensure(): Promise<Connection>;
  restart(): Promise<Connection>;
  stop(): Promise<void>;
  onDidChange(listener: (state: ServerState) => void): () => void;
  dispose(): Promise<void>;
}

export type Logger = (line: string) => void;

abstract class BaseServer implements ServerHandle {
  protected emitter = new EventEmitter();
  protected _state: ServerState = { status: "stopped" };
  protected pending: Promise<Connection> | undefined;

  constructor(readonly folder: string) {}

  abstract readonly managed: boolean;

  get state(): ServerState {
    return this._state;
  }

  protected setState(state: ServerState): void {
    this._state = state;
    this.emitter.emit("change", state);
  }

  onDidChange(listener: (state: ServerState) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  ensure(): Promise<Connection> {
    if (this._state.status === "running") return Promise.resolve(this._state.conn);
    if (!this.pending) {
      this.setState({ status: "starting" });
      this.pending = this.doStart().then(
        (conn) => {
          this.pending = undefined;
          return conn;
        },
        (err: unknown) => {
          this.pending = undefined;
          const error = err instanceof ServerError ? err : new ServerError("startFailed", String(err));
          this.setState({ status: "failed", error });
          throw error;
        },
      );
    }
    return this.pending;
  }

  async restart(): Promise<Connection> {
    await this.stop();
    return this.ensure();
  }

  protected abstract doStart(): Promise<Connection>;
  abstract stop(): Promise<void>;

  async dispose(): Promise<void> {
    await this.stop();
    this.emitter.removeAllListeners();
  }
}

/** Keeps the HTTP status and error tag in logs; `String(ApiError)` would report only the message. */
export function describeServerError(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}${err.tag ? ` (${err.tag})` : ""}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export async function waitForHealthy(conn: Connection, timeoutMs: number, isAlive: () => boolean = () => true): Promise<string> {
  const client = new OpenCodeClient(conn);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline && isAlive()) {
    try {
      const info = await client.info();
      return info.version;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new ServerError("unauthorized", "The OpenCode server rejected the credentials.");
      }
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!isAlive()) throw new ServerError("startFailed", "OpenCode stopped while starting.");
  const detail = lastError === undefined ? "no response before the deadline" : describeServerError(lastError);
  throw new ServerError("startFailed", "The OpenCode server did not become healthy in time.", detail);
}

export interface ManagedServerOptions {
  folder: string;
  executable: string;
  startupTimeoutMs: number;
  autoRestart: boolean;
  log: Logger;
  /** Max automatic restarts inside `restartWindowMs`. */
  maxRestarts?: number;
  restartWindowMs?: number;
  extraEnv?: Record<string, string>;
  /** Directory for PID records used to reap orphaned servers (see orphans.ts). */
  recordsDir: string;
}

const LISTEN_RE = /listening on (https?:\/\/[^\s]+)/i;
/** A child that prints without newlines must not grow an unbounded in-memory buffer. */
const MAX_STDOUT_LINE = 64 * 1024;

/**
 * `executablePath` is machine-overridable, so a workspace can set it. On Windows the child is
 * handed to cmd.exe (npm `.cmd` shims need a shell); letting shell metacharacters through would
 * execute arbitrary commands on startup. Reject such paths instead of trying to quote them.
 */
function validateExecutable(executable: string, isWindows: boolean): void {
  if (!executable || /[\0\r\n]/.test(executable)) {
    throw new ServerError("notInstalled", "The OpenCode executable path is empty or contains a control character.");
  }
  if (isWindows && /["&|<>^%!]/.test(executable)) {
    throw new ServerError(
      "notInstalled",
      `The OpenCode executable path cannot be quoted safely for cmd.exe: "${executable}".`,
    );
  }
}

/** Spawns and supervises `opencode serve` for a single workspace folder. */
export class ManagedServer extends BaseServer {
  readonly managed = true;
  private child: ChildProcess | undefined;
  private stopping = false;
  /** Invalidates a `stop()` that is still awaiting a kill when a new start takes over. */
  private stopGen = 0;
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  /** The delayed restart is shared with `ensure()` so a concurrent caller cannot spawn a second child. */
  private restarting: Promise<Connection> | undefined;
  private cancelRestart: (() => void) | undefined;

  constructor(private readonly opts: ManagedServerOptions) {
    super(opts.folder);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  ensure(): Promise<Connection> {
    return this.restarting ?? super.ensure();
  }

  protected doStart(): Promise<Connection> {
    const { executable, folder, log } = this.opts;
    const password = randomBytes(24).toString("base64url");
    const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
    log(`[server] starting ${executable} ${args.join(" ")} (cwd: ${folder})`);
    // A new start supersedes any stop still in flight: its final setState must not clobber us.
    this.stopGen++;
    this.stopping = false;

    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let healthStarted = false;
      let stderrTail = "";
      let stdoutBuf = "";
      const isWindows = process.platform === "win32";
      validateExecutable(executable, isWindows);
      let child: ChildProcess;
      try {
        child = spawn(isWindows && /\s/.test(executable) ? `"${executable}"` : executable, args, {
          cwd: folder,
          env: { ...process.env, ...this.opts.extraEnv, OPENCODE_PASSWORD: password },
          stdio: ["ignore", "pipe", "pipe"],
          // npm-installed shims on Windows are .cmd files that need a shell.
          shell: isWindows,
          windowsHide: true,
        });
      } catch (err) {
        reject(new ServerError("notInstalled", `Could not start "${executable}".`, String(err)));
        return;
      }
      this.child = child;

      const fail = (error: ServerError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.kill(child);
        reject(error);
      };

      // One deadline measured from process spawn. The health check inherits whatever is left when
      // the listening line appears: two independent full-length timeouts used to let the outer one
      // kill a healthy server that simply printed its URL late.
      const deadline = Date.now() + this.opts.startupTimeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      const timeoutMessage = () => `OpenCode did not become healthy within ${this.opts.startupTimeoutMs} ms.`;

      const timer = setTimeout(() => {
        fail(new ServerError("startFailed", timeoutMessage(), undefined, stderrTail));
      }, this.opts.startupTimeoutMs);

      child.on("error", (err: NodeJS.ErrnoException) => {
        log(`[server] process error: ${err.message}`);
        if (err.code === "ENOENT") {
          fail(new ServerError("notInstalled", `"${executable}" was not found.`, err.message));
        } else {
          fail(new ServerError("startFailed", err.message));
        }
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        // Redact every encoding of the password before storing the tail. It is diagnostic-only
        // (`ServerError.logDetail` → Output channel), never sent to the chat. Redacting before
        // slicing also catches a credential split across two chunks.
        stderrTail = redactSecrets(stderrTail + chunk, password).slice(-4000);
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`[server:stderr] ${redactSecrets(line, password)}`);
      });

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        // Keep only the tail of an unterminated line: startup URLs are short, and a broken child
        // printing forever must not accumulate in memory until the first newline arrives.
        stdoutBuf = (stdoutBuf + chunk).slice(-MAX_STDOUT_LINE);
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          log(`[server] ${redactSecrets(line, password)}`);
          const m = LISTEN_RE.exec(line);
          if (m && !settled && !healthStarted) {
            healthStarted = true;
            clearTimeout(timer);
            const conn: Connection = { baseUrl: m[1], password };
            waitForHealthy(conn, remaining(), () => child.exitCode === null && !settled).then(
              (version) => {
                if (settled) return;
                settled = true;
                ready = true;
                clearTimeout(timer);
                log(`[server] ready at ${conn.baseUrl} (opencode ${version})`);
                if (child.pid) {
                  void writeServerRecord(this.opts.recordsDir, {
                    pid: child.pid,
                    port: Number(new URL(conn.baseUrl).port),
                    folder,
                    ownerPid: process.pid,
                    startedAt: Date.now(),
                  });
                }
                this.setState({ status: "running", conn, version });
                resolve(conn);
              },
              (err: unknown) => fail(err instanceof ServerError ? err : new ServerError("startFailed", String(err))),
            );
          }
        }
      });

      child.on("exit", (code, signal) => {
        log(`[server] exited (code ${code}, signal ${signal})`);
        // Clear only this child's record: a replacement may have written a new one already.
        void clearServerRecord(this.opts.recordsDir, folder, process.pid, child.pid);
        const isCurrent = this.child === child;
        if (isCurrent) this.child = undefined;
        if (!ready) {
          fail(
            new ServerError(
              "startFailed",
              `OpenCode exited during startup (code ${code ?? signal}).`,
              undefined,
              stderrTail.trim() || undefined,
            ),
          );
          return;
        }
        // A child we already stopped or replaced must not trigger a spurious auto-restart, even
        // when a concurrent start has reset `stopping` in the meantime.
        if (this.stopping || !isCurrent) return;
        this.onUnexpectedExit(code, stderrTail);
      });
    });
  }

  private onUnexpectedExit(code: number | null, stderrTail: string): void {
    const now = Date.now();
    const window = this.opts.restartWindowMs ?? 120_000;
    const max = this.opts.maxRestarts ?? 5;
    this.restarts = this.restarts.filter((t) => now - t < window);
    if (!this.opts.autoRestart || this.restarts.length >= max) {
      this.setState({
        status: "failed",
        error: new ServerError("startFailed", `OpenCode stopped unexpectedly (code ${code}).`, undefined, stderrTail.trim() || undefined),
      });
      return;
    }
    const delay = jitteredDelay(Math.min(10_000, 500 * 2 ** this.restarts.length));
    this.restarts.push(now);
    this.opts.log(`[server] restarting in ${delay} ms (attempt ${this.restarts.length}/${max})`);
    this.setState({ status: "starting" });
    let cancel!: () => void;
    const restarting = new Promise<Connection>((resolve, reject) => {
      cancel = () => reject(new ServerError("startFailed", "OpenCode was stopped while waiting to restart."));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.restarting = undefined;
        this.cancelRestart = undefined;
        // `super.ensure()` re-enters the normal start path; `this.ensure()` here would recurse.
        super.ensure().then(resolve, reject);
      }, delay);
    });
    // Nobody is required to await this promise (e.g. `stop()` cancels it); swallow the rejection.
    void restarting.catch(() => {});
    this.restarting = restarting;
    this.cancelRestart = cancel;
  }

  async stop(): Promise<void> {
    const gen = ++this.stopGen;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.cancelRestart) {
      this.cancelRestart();
      this.cancelRestart = undefined;
    }
    this.restarting = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) await this.kill(child);
    void clearServerRecord(this.opts.recordsDir, this.folder, process.pid, child?.pid);
    if (this.pending) await this.pending.catch(() => {});
    // A new start may have taken over while we were awaiting the kill. Its state wins; setting
    // "stopped" here would leave a live server unmanaged and spawn a duplicate on the next ensure.
    if (gen !== this.stopGen) return;
    this.setState({ status: "stopped" });
  }

  private kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let force: NodeJS.Timeout | undefined;
      let fallback: NodeJS.Timeout | undefined;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (force) clearTimeout(force);
        if (fallback) clearTimeout(fallback);
        child.removeListener("exit", done);
        resolve();
      };
      child.once("exit", done);
      force = setTimeout(() => {
        force = undefined;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        // Some platforms never report `exit` for a killed child; settle after a short grace.
        fallback = setTimeout(done, 500);
      }, 3000);
      if (process.platform === "win32" && child.pid) {
        // With shell: true the direct child is cmd.exe; kill the whole tree.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
      } else {
        child.kill("SIGTERM");
      }
    });
  }
}

export interface ExternalServerOptions {
  folder: string;
  endpoint: string;
  getPassword: () => Promise<string | undefined>;
  log: Logger;
}

/** Connects to a server the user runs themselves (`opencode.endpoint`). */
export class ExternalServer extends BaseServer {
  readonly managed = false;

  constructor(private readonly opts: ExternalServerOptions) {
    super(opts.folder);
  }

  protected async doStart(): Promise<Connection> {
    const password = await this.opts.getPassword();
    const conn: Connection = { baseUrl: this.opts.endpoint, password };
    this.opts.log(`[server] connecting to external server ${this.opts.endpoint}`);
    try {
      const info = await new OpenCodeClient(conn).info();
      this.setState({ status: "running", conn, version: info.version });
      return conn;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new ServerError("unauthorized", "The OpenCode server requires a password.");
      }
      throw new ServerError("unreachable", `Cannot reach ${this.opts.endpoint}.`, describeServerError(err));
    }
  }

  async stop(): Promise<void> {
    if (this.pending) await this.pending.catch(() => {});
    this.setState({ status: "stopped" });
  }
}
