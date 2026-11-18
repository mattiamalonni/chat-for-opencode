import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { ApiError, OpenCodeClient, type Connection } from "../client/http";
import { clearServerRecord, writeServerRecord } from "./orphans";

export type ServerErrorKind = "notInstalled" | "startFailed" | "unauthorized" | "unreachable";

export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
    readonly detail?: string,
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
  throw new ServerError("startFailed", "The OpenCode server did not become healthy in time.", String(lastError ?? ""));
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

/** Spawns and supervises `opencode serve` for a single workspace folder. */
export class ManagedServer extends BaseServer {
  readonly managed = true;
  private child: ChildProcess | undefined;
  private stopping = false;
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: ManagedServerOptions) {
    super(opts.folder);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  protected doStart(): Promise<Connection> {
    const { executable, folder, log } = this.opts;
    const password = randomBytes(24).toString("base64url");
    const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
    log(`[server] starting ${executable} ${args.join(" ")} (cwd: ${folder})`);
    this.stopping = false;

    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let stderrTail = "";
      let stdoutBuf = "";
      const isWindows = process.platform === "win32";
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

      const timer = setTimeout(() => {
        fail(
          new ServerError(
            "startFailed",
            `OpenCode did not report a listening address within ${this.opts.startupTimeoutMs} ms.`,
            stderrTail,
          ),
        );
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
        stderrTail = (stderrTail + chunk).slice(-4000);
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`[server:stderr] ${redact(line, password)}`);
      });

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          log(`[server] ${redact(line, password)}`);
          const m = LISTEN_RE.exec(line);
          if (m && !settled) {
            const conn: Connection = { baseUrl: m[1], password };
            waitForHealthy(conn, this.opts.startupTimeoutMs, () => child.exitCode === null && !settled).then(
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
        void clearServerRecord(this.opts.recordsDir, folder);
        if (this.child === child) this.child = undefined;
        if (!ready) {
          fail(
            new ServerError(
              "startFailed",
              `OpenCode exited during startup (code ${code ?? signal}).`,
              stderrTail.trim() || undefined,
            ),
          );
          return;
        }
        if (this.stopping) return;
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
        error: new ServerError("startFailed", `OpenCode stopped unexpectedly (code ${code}).`, stderrTail.trim() || undefined),
      });
      return;
    }
    const delay = Math.min(10_000, 500 * 2 ** this.restarts.length);
    this.restarts.push(now);
    this.opts.log(`[server] restarting in ${delay} ms (attempt ${this.restarts.length}/${max})`);
    this.setState({ status: "starting" });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this._state = { status: "stopped" };
      this.ensure().catch(() => {});
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) await this.kill(child);
    void clearServerRecord(this.opts.recordsDir, this.folder);
    if (this.pending) await this.pending.catch(() => {});
    this.setState({ status: "stopped" });
  }

  private kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      child.once("exit", done);
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        setTimeout(resolve, 500);
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

function redact(line: string, secret: string): string {
  return line.split(secret).join("***").replace(/(server password\s+)\S+/i, "$1***");
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
      throw new ServerError("unreachable", `Cannot reach ${this.opts.endpoint}.`, String(err));
    }
  }

  async stop(): Promise<void> {
    if (this.pending) await this.pending.catch(() => {});
    this.setState({ status: "stopped" });
  }
}
