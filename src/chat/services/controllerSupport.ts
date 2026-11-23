import * as vscode from "vscode";
import { ApiError } from "../../client/http";
import { DEFAULT_STARTUP_TIMEOUT_MS } from "../../shared/constants";
import type { SessionMessage } from "../../shared/api";
import type { UiError, UiErrorKind } from "../../shared/protocol";
import { STRINGS, type Strings } from "../../shared/strings";
import { normalizeEndpoint } from "../../server/endpoint";
import { ExternalServer, ManagedServer, ServerError, type ServerHandle } from "../../server/server";
import { PASSWORD_KEY } from "../storageKeys";

/** Bounds for the bulk-delete walk: a broken server must not keep the extension host busy forever. */
export const MAX_DELETE_PAGES = 100;
export const MAX_DELETE_IDS = 10_000;

/**
 * How often an open session is re-read from history. The SSE stream only carries events from the
 * server process we connected to: a prompt typed in the TUI (or any other client sharing the
 * on-disk session storage) never reaches it, so history is the only way to see it live.
 */
export const LIVE_POLL_MS = 2000;

/** Child ids recorded in the tool state of a loaded session's history. */
export function subagentSessionsFromMessages(messages: SessionMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "tool" || (part.name !== "subagent" && part.name !== "task")) continue;
      const id = (part.state as { metadata?: { sessionID?: unknown } }).metadata?.sessionID;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

let cachedStrings: Strings | undefined;
/** Locale and the string table are static for a session: translate once, not on every error/reconnect. */
export function translatedStrings(): Strings {
  return (cachedStrings ??= Object.fromEntries(Object.entries(STRINGS).map(([k, v]) => [k, vscode.l10n.t(v)])) as Strings);
}

/** One server per workspace folder, created lazily. */
export class ServerRegistry implements vscode.Disposable {
  private readonly servers = new Map<string, ServerHandle>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (line: string) => void,
    private readonly recordsDir: string,
  ) {}

  get(folder: vscode.WorkspaceFolder): ServerHandle {
    const key = folder.uri.toString();
    let server = this.servers.get(key);
    if (!server) {
      const cfg = vscode.workspace.getConfiguration("opencode", folder.uri);
      const endpoint = normalizeEndpoint(cfg.get<string>("endpoint", "").trim());
      server = endpoint.baseUrl
        ? new ExternalServer({
            folder: folder.uri.fsPath,
            endpoint: endpoint.baseUrl,
            // Credentials in userinfo are a fallback; an explicitly stored password wins.
            getPassword: async () => (await this.secrets.get(PASSWORD_KEY(endpoint.baseUrl))) ?? endpoint.password,
            log: this.log,
          })
        : new ManagedServer({
            folder: folder.uri.fsPath,
            executable: cfg.get<string>("executablePath", "opencode").trim() || "opencode",
            startupTimeoutMs: cfg.get<number>("startupTimeout", DEFAULT_STARTUP_TIMEOUT_MS),
            autoRestart: cfg.get<boolean>("autoRestart", true),
            log: this.log,
            recordsDir: this.recordsDir,
          });
      this.servers.set(key, server);
    }
    return server;
  }

  async reset(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.dispose()));
  }

  async dispose(): Promise<void> {
    await this.reset();
  }
}

export function toUiError(err: unknown, fallback: UiErrorKind = "requestFailed"): UiError {
  const s = translatedStrings();
  if (err instanceof ServerError) {
    switch (err.kind) {
      case "notInstalled":
        return {
          kind: "notInstalled",
          message: s["error.notInstalled"],
          detail: err.detail ?? err.message,
          actions: ["install", "openSettings", "showLogs"],
        };
      case "unauthorized":
        return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "openSettings"] };
      case "unreachable":
        return {
          kind: "connectionLost",
          message: s["error.connectionLost"],
          detail: err.detail ?? err.message,
          actions: ["reconnect", "openSettings", "showLogs"],
        };
      default:
        return {
          kind: "startFailed",
          message: s["error.startFailed"],
          detail: [err.message, err.detail].filter(Boolean).join("\n"),
          actions: ["reconnect", "showLogs", "openSettings"],
        };
    }
  }
  if (err instanceof ApiError && err.status === 401) {
    return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "reconnect"] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: fallback, message: s[`error.${fallback}`], detail: message, actions: ["reconnect", "showLogs"] };
}
