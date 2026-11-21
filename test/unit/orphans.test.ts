import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  lsofOutput: "",
  lsofFails: false,
  fetchStatus: 401,
  fetchAuth: "Basic realm=\"Secure Area\"" as string | null,
  fetchBody: {} as unknown,
  alivePids: new Set<number>(),
  killed: [] as Array<[number, string | number | undefined]>,
  spawned: [] as string[][],
}));

vi.mock("node:fs", () => ({
  promises: {
    readdir: async () => [...state.files.keys()].map((p) => p.split("/").at(-1)!),
    readFile: async (p: string) => {
      const value = state.files.get(p);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    unlink: async (p: string) => {
      state.files.delete(p);
    },
    mkdir: async () => undefined,
    writeFile: async (p: string, value: string) => {
      state.files.set(p, value);
    },
  },
}));

vi.mock("node:child_process", () => ({
  // Callback style so promisify() in orphans.ts wraps it.
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (state.lsofFails) cb(new Error("lsof not found"), { stdout: "", stderr: "" });
    else cb(null, { stdout: state.lsofOutput, stderr: "" });
  },
  spawn: (cmd: string, args: string[]) => {
    state.spawned.push([cmd, ...args]);
    return { on: () => undefined };
  },
}));

import { cleanupOrphanServers, writeServerRecord, type ServerRecord } from "../../src/server/orphans";

const DIR = "/records";
const FOLDER = "/work/project";

function record(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return { pid: 4242, port: 4096, folder: FOLDER, ownerPid: 100, startedAt: 1, ...overrides };
}

async function add(r: ServerRecord): Promise<void> {
  await writeServerRecord(DIR, r);
}

function signalsTo(pid: number): Array<string | number | undefined> {
  // Ignore the `kill(pid, 0)` liveness probes; only real termination signals count.
  return state.killed
    .filter(([p, signal]) => p === pid && signal !== 0 && signal !== undefined)
    .map(([, signal]) => signal);
}

describe("cleanupOrphanServers", () => {
  beforeEach(() => {
    state.files.clear();
    state.killed.length = 0;
    state.spawned.length = 0;
    state.alivePids.clear();
    state.lsofOutput = "4242\n";
    state.lsofFails = false;
    state.fetchStatus = 401;
    state.fetchAuth = 'Basic realm="Secure Area"';
    state.fetchBody = {};
    vi.stubGlobal("fetch", async () => ({
      status: state.fetchStatus,
      ok: state.fetchStatus >= 200 && state.fetchStatus < 300,
      headers: { get: (key: string) => (key.toLowerCase() === "www-authenticate" ? state.fetchAuth : null) },
      json: async () => state.fetchBody,
    }));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      state.killed.push([pid, signal]);
      if ((signal === 0 || signal === undefined) && !state.alivePids.has(pid)) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
  });

  it("leaves a server whose owning window is still alive", async () => {
    state.alivePids.add(100).add(4242);
    await add(record());
    const log = vi.fn();
    await cleanupOrphanServers(DIR, log);
    expect(signalsTo(4242)).toEqual([]);
    expect(state.files.size).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("reaps a dead owner's server that answers like OpenCode and owns the port", async () => {
    state.alivePids.add(4242);
    await add(record());
    const log = vi.fn();
    await cleanupOrphanServers(DIR, log);
    expect(signalsTo(4242)).toContain("SIGTERM");
    expect(state.files.size).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not kill on PID reuse when another process owns the port", async () => {
    state.alivePids.add(4242);
    state.lsofOutput = "9999\n"; // the recorded pid no longer listens
    await add(record());
    await cleanupOrphanServers(DIR, vi.fn());
    expect(signalsTo(4242)).toEqual([]);
    expect(state.files.size).toBe(0);
  });

  it("does not kill when lsof is unavailable (conservative skip)", async () => {
    state.alivePids.add(4242);
    state.lsofFails = true;
    await add(record());
    await cleanupOrphanServers(DIR, vi.fn());
    expect(signalsTo(4242)).toEqual([]);
  });

  it("rejects a 200 whose reported pid differs from the record", async () => {
    state.alivePids.add(4242);
    state.fetchStatus = 200;
    state.fetchBody = { pid: 7777 };
    await add(record());
    await cleanupOrphanServers(DIR, vi.fn());
    expect(signalsTo(4242)).toEqual([]);
    expect(state.files.size).toBe(0);
  });

  it("removes invalid records without killing anything", async () => {
    state.files.set(`${DIR}/broken.json`, '{"pid":"nope"}');
    await cleanupOrphanServers(DIR, vi.fn());
    expect(state.files.size).toBe(0);
    expect(state.killed).toEqual([]);
  });

  it("removes the record of a server that is already gone", async () => {
    // Neither the owner nor the recorded pid is alive.
    await add(record());
    await cleanupOrphanServers(DIR, vi.fn());
    expect(signalsTo(4242)).toEqual([]);
    expect(state.files.size).toBe(0);
  });
});
