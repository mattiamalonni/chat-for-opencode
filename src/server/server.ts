import { EventEmitter } from "node:events";
import { ApiError, OpenCodeClient, type Connection } from "../client/http";
import type { SdkHost } from "../sdk/bridge";
import { loadSdkBridge } from "../sdk/loader";

export type ServerErrorKind = "startFailed" | "unauthorized" | "unreachable";

export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
    /** Safe to show in the chat: a short diagnosis produced by this extension. */
    readonly detail?: string,
    /** Diagnostic-only output, written to the Output channel and never sent to the webview. */
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

/** Keeps the HTTP status and error tag for external-client errors in logs. */
export function describeServerError(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}${err.tag ? ` (${err.tag})` : ""}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export interface ManagedServerOptions {
  folder: string;
  log: Logger;
}

/**
 * Hosts OpenCode in-process through the SDK. No binary on PATH, no child process, no listener, no
 * password: the generated client runs the server router in memory.
 */
export class ManagedServer extends BaseServer {
  readonly managed = true;
  private host: SdkHost | undefined;

  constructor(private readonly opts: ManagedServerOptions) {
    super(opts.folder);
  }

  protected async doStart(): Promise<Connection> {
    const { folder, log } = this.opts;
    log("[sdk] starting embedded OpenCode host");
    try {
      const bridge = await loadSdkBridge();
      const host = await bridge.createHost();
      this.host = host;
      const conn: Connection = {
        key: `embedded:${folder}`,
        embedded: true,
        baseUrl: "in-process",
        directory: folder,
        api: host,
      };
      const version = (await OpenCodeClient.create(conn).info()).version ?? "unknown";
      log(`[sdk] host ready (opencode ${version})`);
      this.setState({ status: "running", conn, version });
      return conn;
    } catch (err) {
      const error = err instanceof ServerError ? err : new ServerError("startFailed", String(err), describeServerError(err));
      // A host that was created but failed its first `info()` still holds the database and
      // watchers: close it instead of dropping the only reference to it.
      await this.closeHost();
      throw error;
    }
  }

  async stop(): Promise<void> {
    // A stop during startup must wait for it: otherwise the host created afterwards is assigned
    // after this method cleared it, the state flips back to "running" and the host is never closed.
    if (this.pending) await this.pending.catch(() => {});
    await this.closeHost();
    this.setState({ status: "stopped" });
  }

  private async closeHost(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    if (host) {
      try {
        await host.close?.();
      } catch (err) {
        this.opts.log(`[sdk] close failed: ${String(err)}`);
      }
    }
  }
}

export interface ExternalServerOptions {
  folder: string;
  endpoint: string;
  getPassword: () => Promise<string | undefined>;
  log: Logger;
}

/** Connects to a server the user runs themselves (`opencode.endpoint`) via the generated client. */
export class ExternalServer extends BaseServer {
  readonly managed = false;

  constructor(private readonly opts: ExternalServerOptions) {
    super(opts.folder);
  }

  protected async doStart(): Promise<Connection> {
    const password = await this.opts.getPassword();
    const bridge = await loadSdkBridge();
    const conn: Connection = {
      key: `external:${this.opts.endpoint}:${password ?? ""}`,
      embedded: false,
      baseUrl: this.opts.endpoint,
      password,
      directory: this.opts.folder,
      api: bridge.makeNetworkApi(this.opts.endpoint, password),
    };
    this.opts.log(`[server] connecting to external server ${this.opts.endpoint}`);
    try {
      const info = await OpenCodeClient.create(conn).info();
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
