import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeFileCache, excludeGlobs, FileIndex, serializeFileCache } from "../../src/chat/context";
import type { SessionMessage } from "../../src/shared/api";
import { chatReducer, contextTokensOf, initialChatState } from "../../src/shared/chatReducer";
import { formatTokens } from "../../src/shared/format";

// Minimal in-memory VS Code host so `FileIndex` can be exercised in plain Node. `findFiles` is a
// deferred promise, letting a test invalidate while a scan is still in flight.
vi.mock("vscode", () => {
  const callbacks: Record<string, (uri: { fsPath: string }) => void> = {};
  const watcher = {
    onDidCreate: (cb: (uri: { fsPath: string }) => void) => {
      callbacks.create = cb;
    },
    onDidDelete: (cb: (uri: { fsPath: string }) => void) => {
      callbacks.delete = cb;
    },
    dispose: vi.fn(),
  };
  let resolveFind: ((files: unknown[]) => void) | undefined;
  const state = {
    callbacks,
    watcher,
    findFiles: vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveFind = resolve;
        }),
    ),
    resolveFind: (files: unknown[]) => resolveFind?.(files),
    config: {} as Record<string, unknown>,
    storageValues: {} as Record<string, unknown>,
    updates: vi.fn(async (_key: string, _value: unknown) => {}),
  };
  return {
    __state: state,
    workspace: {
      getConfiguration: () => ({ get: (key: string) => state.config[key] }),
      createFileSystemWatcher: () => watcher,
      findFiles: state.findFiles,
    },
    RelativePattern: class {
      constructor(..._args: unknown[]) {}
    },
    Uri: {
      parse: (value: string) => ({
        toString: () => value,
        fsPath: value.replace(/^file:\/\//, ""),
        with: () => ({ toString: () => value }),
      }),
    },
  };
});

interface MockState {
  callbacks: Record<string, (uri: { fsPath: string }) => void>;
  findFiles: ((...args: unknown[]) => Promise<unknown[]>) & { mock: { calls: unknown[][] } };
  resolveFind: (files: unknown[]) => void;
  config: Record<string, unknown>;
  storageValues: Record<string, unknown>;
  updates: ((key: string, value: unknown) => Promise<void>) & { mock: { calls: unknown[][] } };
  watcher: { dispose: object };
}
const mock = (vscode as unknown as { __state: MockState }).__state;

describe("excludeGlobs", () => {
  it("includes configured excludes and keeps their glob form", () => {
    expect(excludeGlobs({ "**/node_modules": true, "**/.git": true, "**/dist": false })).toEqual(["**/node_modules", "**/.git"]);
  });

  it("removes duplicates across settings", () => {
    expect(excludeGlobs({ "**/node_modules": true }, ["**/node_modules", "**/build"])).toEqual(["**/node_modules", "**/build"]);
  });

  it("ignores non-string values and malformed settings", () => {
    expect(excludeGlobs(["**/node_modules", 42, null, undefined, true, {}])).toEqual(["**/node_modules"]);
    expect(excludeGlobs(undefined, 7, "**/node_modules")).toEqual([]);
  });

  it("returns nothing when there are no excludes", () => {
    expect(excludeGlobs()).toEqual([]);
    expect(excludeGlobs({}, undefined)).toEqual([]);
  });
});

describe("file index cache serialization", () => {
  const uri = (value: string) => ({ toString: () => value });

  it("round-trips a snapshot", () => {
    const cache = serializeFileCache([uri("file:///a.ts"), uri("file:///b.ts")], ["**/node_modules"]);
    expect(deserializeFileCache(cache, ["**/node_modules"])).toEqual(["file:///a.ts", "file:///b.ts"]);
  });

  it("NFC-normalizes and deduplicates file strings", () => {
    const composed = "file:///caff\u00e9.ts";
    const decomposed = "file:///caffe\u0301.ts";
    const cache = serializeFileCache([uri(composed), uri(decomposed), uri(composed)], []);
    expect(cache).toEqual({ version: 1, exclude: [], files: [composed] });
    expect(deserializeFileCache(cache, [])).toEqual([composed]);
  });

  it("treats the cache as stale when the exclude set changes", () => {
    const cache = serializeFileCache([uri("file:///a.ts")], ["**/node_modules"]);
    expect(deserializeFileCache(cache, ["**/node_modules", "**/dist"])).toBeUndefined();
    expect(deserializeFileCache(cache, ["**/dist"])).toBeUndefined();
  });

  it("accepts the same excludes in a different order", () => {
    const cache = serializeFileCache([uri("file:///a.ts")], ["**/dist", "**/node_modules"]);
    expect(deserializeFileCache(cache, ["**/node_modules", "**/dist"])).toEqual(["file:///a.ts"]);
  });

  it("treats an unknown version as stale", () => {
    const cache = serializeFileCache([uri("file:///a.ts")], []);
    expect(deserializeFileCache({ ...(cache as Record<string, unknown>), version: 2 }, [])).toBeUndefined();
  });

  it("ignores malformed values", () => {
    expect(deserializeFileCache(undefined, [])).toBeUndefined();
    expect(deserializeFileCache(null, [])).toBeUndefined();
    expect(deserializeFileCache("oops", [])).toBeUndefined();
    expect(deserializeFileCache([], [])).toBeUndefined();
    expect(deserializeFileCache({ version: 1, exclude: [], files: "nope" }, [])).toBeUndefined();
    expect(deserializeFileCache({ version: 1, exclude: "nope", files: [] }, [])).toBeUndefined();
    expect(deserializeFileCache({ version: 1, exclude: [42], files: [] }, [])).toBeUndefined();
    expect(deserializeFileCache({ version: 1, exclude: [], files: ["file:///a.ts", 42, null] }, [])).toEqual(["file:///a.ts"]);
  });
});

describe("FileIndex invalidation", () => {
  const folder = {
    uri: { toString: () => "file:///workspace", fsPath: "/workspace" },
  } as unknown as vscode.WorkspaceFolder;
  const file = (name: string) => ({ fsPath: `/workspace/${name}`, toString: () => `file:///workspace/${name}` });

  function storage(): vscode.Memento {
    return {
      get: (key: string) => mock.storageValues[key],
      update: (key: string, value: unknown) => {
        mock.updates(key, value);
        if (value === undefined) delete mock.storageValues[key];
        else mock.storageValues[key] = value;
        return Promise.resolve();
      },
    } as unknown as vscode.Memento;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mock.callbacks)) delete mock.callbacks[key];
    for (const key of Object.keys(mock.config)) delete mock.config[key];
    for (const key of Object.keys(mock.storageValues)) delete mock.storageValues[key];
  });

  it("does not restore or persist a scan that finishes after an invalidation", async () => {
    const index = new FileIndex(folder, storage());

    const stale = index.search("a");
    expect(mock.findFiles.mock.calls.length).toBe(1);

    // A watched file event invalidates the index while the scan is still in flight.
    mock.callbacks.create({ fsPath: "/workspace/deleted.ts" });

    mock.resolveFind([file("a.ts")]);
    await stale;

    // The snapshot was cleared on invalidation and never re-written with the stale result.
    expect(mock.updates.mock.calls).toEqual([[expect.stringContaining("opencode.fileIndex:"), undefined]]);

    // The stale result was not committed: the next search rescans and persists fresh data.
    const fresh = index.search("b");
    expect(mock.findFiles.mock.calls.length).toBe(2);
    mock.resolveFind([file("b.ts")]);
    expect(await fresh).toEqual([expect.objectContaining({ name: "b.ts" })]);
    expect(mock.updates.mock.calls.at(-1)).toEqual([expect.any(String), expect.objectContaining({ files: ["file:///workspace/b.ts"] })]);
  });

  it("does not commit a scan that finishes after dispose", async () => {
    const index = new FileIndex(folder, storage());

    const pending = index.search("a");
    expect(mock.findFiles.mock.calls.length).toBe(1);

    index.dispose();
    expect(mock.watcher.dispose).toHaveBeenCalledTimes(1);

    mock.resolveFind([file("a.ts")]);
    await pending;
    expect(mock.updates.mock.calls).toEqual([]);

    // The post-dispose result was not cached, so a later search starts a new scan.
    const later = index.search("c");
    expect(mock.findFiles.mock.calls.length).toBe(2);
    mock.resolveFind([file("c.ts")]);
    expect(await later).toEqual([expect.objectContaining({ name: "c.ts" })]);
  });
});

const tokens = (input: number, read: number, output: number, reasoning = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
});

describe("context usage", () => {
  it("adds cached tokens to input (input excludes cache in opencode 2.2.7)", () => {
    // Real numbers: step 2 prompt (324 + 8192) ≈ step 1 prompt (6943 + 1536) + new message.
    expect(contextTokensOf(tokens(6943, 1536, 3, 14))).toBe(8496);
    expect(contextTokensOf(tokens(324, 8192, 3, 17))).toBe(8536);
    expect(contextTokensOf(tokens(0, 0, 0))).toBeUndefined();
  });

  const assistant = (id: string, created: number, t?: ReturnType<typeof tokens>): SessionMessage => ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created, completed: created },
    content: [],
    tokens: t,
  });

  it("uses the last step with tokens from history and resets after a compaction", () => {
    const load = (messages: SessionMessage[]) =>
      chatReducer(initialChatState, { type: "load", sessionId: "s", messages, permissions: [], forms: [] });
    expect(load([assistant("a", 1, tokens(100, 0, 10)), assistant("b", 2, tokens(50, 200, 5)), assistant("c", 3)]).contextTokens).toBe(255);
    const compaction = { id: "x", type: "compaction", status: "completed", time: { created: 4 } } as unknown as SessionMessage;
    expect(load([assistant("a", 1, tokens(100, 0, 10)), compaction]).contextTokens).toBeUndefined();
  });

  it("updates live from step.ended and clears on compaction", () => {
    let state = chatReducer(initialChatState, { type: "load", sessionId: "s", messages: [], permissions: [], forms: [] });
    state = chatReducer(state, {
      type: "event",
      event: {
        type: "session.step.ended",
        data: { sessionID: "s", assistantMessageID: "m1", finish: "stop", tokens: tokens(1000, 4000, 200) },
      },
    });
    expect(state.contextTokens).toBe(5200);
    state = chatReducer(state, {
      type: "event",
      event: { type: "session.compaction.ended", data: { sessionID: "s", reason: "auto", text: "" } },
    });
    expect(state.contextTokens).toBeUndefined();
  });

  it("formats token counts compactly", () => {
    expect([950, 8496, 128000, 200000, 1000000, 1048576, 1500000].map(formatTokens)).toEqual([
      "950",
      "8.5K",
      "128K",
      "200K",
      "1M",
      "1M",
      "1.5M",
    ]);
  });
});
