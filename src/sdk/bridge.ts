/**
 * ESM bridge to the in-process OpenCode host.
 *
 * `@opencode/sdk` is ESM-only and needs Node 24's explicit resource management. This module is
 * bundled into the single ESM extension entry. Nothing here speaks HTTP: the embedded host runs
 * OpenCode's HTTP router in memory and the generated client calls it directly.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/sdk";
import { OpenCode as NetworkClient } from "@opencode/client";
import { dependencies } from "../../package.json";

type EmbeddedHost = Awaited<ReturnType<typeof OpenCode.create>>;
/** The generated client groups shared by the embedded host and a remote endpoint client. */
export type SdkHost = Omit<EmbeddedHost, "close" | "sessions" | "events" | "plugin" | typeof Symbol.asyncDispose> & {
  close?: () => Promise<void>;
};

export interface CreateHostOptions {
  /** Test seam / explicit override. Defaults to OpenCode's own global database. */
  databasePath?: string;
}

/** The OpenCode global database, shared with the CLI/TUI and persisted across window reloads. */
export function defaultDatabasePath(): string {
  if (process.env.OPENCODE_DATABASE_PATH) return process.env.OPENCODE_DATABASE_PATH;
  const root = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(root, "opencode", "opencode.db");
}

/**
 * The OpenCode version the embedded host reports to providers, taken from the pinned SDK
 * dependency. Without it the SDK sends `unknown` (`User-Agent: opencode/unknown/unknown/sdk`), and
 * the OpenCode gateway treats such clients as anonymous: free models answer "Free usage limit
 * reached" even with a signed-in account, and an older version gets HTTP 426.
 */
export const SDK_VERSION = dependencies["@opencode/sdk"].replace(/^[^\d]*/, "");

/**
 * Creates the embedded OpenCode host. One host serves every workspace location. An explicit
 * database path keeps sessions available after the host closes.
 */
export function createHost(options: CreateHostOptions = {}): Promise<SdkHost> {
  return OpenCode.create({
    app: { version: SDK_VERSION },
    database: { path: options.databasePath ?? defaultDatabasePath() },
  });
}

/**
 * Client for the user-supplied `opencode.endpoint`, the only path that goes over the network. It
 * uses OpenCode's generated client.
 */
export function makeNetworkApi(baseUrl: string, password?: string): SdkHost {
  const headers: Record<string, string> = password
    ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    : {};
  return NetworkClient.make({ baseUrl, headers });
}
