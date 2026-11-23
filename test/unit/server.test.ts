import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, OpenCodeClient } from "../../src/client/http";
import { clearServerRecord, writeServerRecord } from "../../src/server/orphans";
import { describeServerError, ExternalServer, ManagedServer, waitForHealthy, type ServerState } from "../../src/server/server";
import { startMockServer, type MockServer } from "../mock/mockServer";

const MOCK = join(__dirname, "../mock/mockServer.ts");

/**
 * A fake `opencode` executable that runs the mock server CLI. On Windows a `.cmd` shim is used
 * because ManagedServer spawns through cmd.exe there; a POSIX shell script would be inert.
 */
function fakeOpencode(env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-fake-"));
  if (isWindows) {
    const file = join(dir, "opencode.cmd");
    const setEnv = env ? `set ${env}&& ` : "";
    writeFileSync(file, `@echo off\r\n${setEnv}"${process.execPath}" --no-warnings "${MOCK}" %*\r\n`);
    return file;
  }
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/bin/sh\n${env} exec "${process.execPath}" --no-warnings "${MOCK}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

const isWindows = process.platform === "win32";

describe("ManagedServer", () => {
  const servers: ManagedServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.dispose()));
    servers.length = 0;
  });

  function make(executable: string, extra: Partial<ConstructorParameters<typeof ManagedServer>[0]> = {}) {
    const logs: string[] = [];
    const server = new ManagedServer({
      folder: tmpdir(),
      executable,
      startupTimeoutMs: 10_000,
      autoRestart: true,
      log: (l) => logs.push(l),
      recordsDir: mkdtempSync(join(tmpdir(), "oc-records-")),
      ...extra,
    });
    servers.push(server);
    return { server, logs };
  }

  it("starts on a dynamic port with a random password and never logs it", async () => {
    const { server, logs } = make(fakeOpencode());
    const conn = await server.ensure();
    expect(conn.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(conn.password).toBeTruthy();
    expect(server.state.status).toBe("running");
    expect((await new OpenCodeClient(conn).info()).version).toBe("2.3.0-mock");
    expect(logs.join("\n")).not.toContain(conn.password!);
    // ensure() is idempotent
    expect(await server.ensure()).toBe(conn);
  });

  it("reports notInstalled when the executable is missing", async () => {
    // With `shell: true`, cmd.exe swallows the child's ENOENT, so exercise the Windows-specific
    // validation branch instead: an unsafe path must be rejected before anything is spawned.
    const missing = isWindows ? 'C:\\not"here\\opencode' : "/definitely/not/here/opencode";
    const { server } = make(missing);
    await expect(server.ensure()).rejects.toMatchObject({ kind: "notInstalled" });
    expect(server.state.status).toBe("failed");
  });

  it("keeps stderr in the diagnostic log detail, not in the UI detail", async () => {
    const { server } = make(fakeOpencode("MOCK_FAIL_START=1"));
    const err = await server.ensure().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "startFailed" });
    expect((err as { logDetail?: string }).logDetail).toContain("simulated startup failure");
    expect((err as { detail?: string }).detail).toBeUndefined();
  });

  it("redacts the password from stderr before exposing it as diagnostic detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fake-"));
    // The child runs through cmd.exe on Windows, so a .cmd shim is required there; a POSIX script
    // would be inert and cmd.exe would report it as "not recognized" instead of our stderr line.
    const file = isWindows ? join(dir, "opencode.cmd") : join(dir, "opencode");
    if (isWindows) {
      writeFileSync(file, "@echo off\r\necho server password %OPENCODE_PASSWORD% leaked 1>&2\r\nexit /b 1\r\n");
    } else {
      writeFileSync(file, '#!/bin/sh\necho "server password $OPENCODE_PASSWORD leaked" >&2\nexit 1\n');
      chmodSync(file, 0o755);
    }
    const { server } = make(file);
    const err = await server.ensure().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "startFailed" });
    const detail = (err as { logDetail?: string }).logDetail ?? "";
    expect(detail).toContain("server password ***");
    expect(detail).not.toMatch(/server password\s+[A-Za-z0-9+/=]{16,}/);
    expect((err as { detail?: string }).detail).toBeUndefined();
  });

  it("restarts automatically after a crash and stops cleanly", async () => {
    const { server } = make(fakeOpencode());
    const first = await server.ensure();
    const states: ServerState["status"][] = [];
    server.onDidChange((s) => states.push(s.status));
    const client = new OpenCodeClient(first);
    const session = await client.createSession({});
    await client.prompt(session.id, "[crash]").catch(() => {});
    await waitFor(() => states.includes("running"), 10_000);
    expect(states[0]).toBe("starting");
    const second = server.state.status === "running" ? server.state.conn : undefined;
    expect(second?.baseUrl).not.toBe(first.baseUrl);
    const pid = server.pid;
    await server.stop();
    expect(server.state.status).toBe("stopped");
    expect(pid && isAlive(pid)).toBe(false);
  });

  it("gives up after maxRestarts", async () => {
    const { server } = make(fakeOpencode(), { maxRestarts: 0 });
    const conn = await server.ensure();
    const client = new OpenCodeClient(conn);
    const session = await client.createSession({});
    await client.prompt(session.id, "[crash]").catch(() => {});
    await waitFor(() => server.state.status === "failed", 5000);
  });

  it("ends in the running state when a stop races with a restart", async () => {
    const { server } = make(fakeOpencode());
    await server.ensure();
    // A stop still awaiting its kill must not overwrite the state of the start that took over.
    await Promise.all([server.stop(), server.restart()]);
    expect(server.state.status).toBe("running");
  });
});

describe("server error diagnostics", () => {
  it("keeps the HTTP status and tag in error details", () => {
    expect(describeServerError(new ApiError("boom", 503, "Unavailable"))).toBe("HTTP 503 (Unavailable): boom");
    expect(describeServerError(new Error("oops"))).toBe("Error: oops");
  });

  it("distinguishes a stopped server from a startup timeout", async () => {
    await expect(waitForHealthy({ baseUrl: "http://127.0.0.1:1" }, 1_000, () => false)).rejects.toMatchObject({
      kind: "startFailed",
      message: "OpenCode stopped while starting.",
    });
  });
});

describe("ExternalServer", () => {
  let mock: MockServer;
  afterEach(() => mock?.close());

  it("connects with the stored password and reports unauthorized otherwise", async () => {
    mock = await startMockServer({ password: "pw" });
    const ok = new ExternalServer({ folder: "/", endpoint: mock.url, getPassword: async () => "pw", log: () => {} });
    expect((await ok.ensure()).password).toBe("pw");
    const bad = new ExternalServer({ folder: "/", endpoint: mock.url, getPassword: async () => undefined, log: () => {} });
    await expect(bad.ensure()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("reports unreachable endpoints", async () => {
    const s = new ExternalServer({ folder: "/", endpoint: "http://127.0.0.1:9", getPassword: async () => "x", log: () => {} });
    await expect(s.ensure()).rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("server records", () => {
  const folder = "/work/project";

  it("keys records by owner so two windows on the same folder get separate files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-records-"));
    await writeServerRecord(dir, { pid: 100, port: 4000, folder, ownerPid: 111, startedAt: 1 });
    await writeServerRecord(dir, { pid: 200, port: 5000, folder, ownerPid: 222, startedAt: 2 });

    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{16}-\d+\.json$/);

    await clearServerRecord(dir, folder, 111);
    const remaining = readdirSync(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("-222.json");
  });

  it("keeps a replacement's record when a stale child exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-records-"));
    await writeServerRecord(dir, { pid: 200, port: 5000, folder, ownerPid: process.pid, startedAt: 2 });
    // The old child's late exit must not delete the record written by the replacement.
    await clearServerRecord(dir, folder, process.pid, 100);
    expect(readdirSync(dir)).toHaveLength(1);
    await clearServerRecord(dir, folder, process.pid, 200);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
