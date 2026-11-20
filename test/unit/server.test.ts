import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeClient } from "../../src/client/http";
import { clearServerRecord, writeServerRecord } from "../../src/server/orphans";
import { ExternalServer, ManagedServer, type ServerState } from "../../src/server/server";
import { startMockServer, type MockServer } from "../mock/mockServer";

const MOCK = join(__dirname, "../mock/mockServer.ts");

/** A fake `opencode` executable that runs the mock server CLI. */
function fakeOpencode(env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-fake-"));
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/bin/sh\n${env} exec "${process.execPath}" --no-warnings "${MOCK}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ManagedServer", () => {
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
    expect((await new OpenCodeClient(conn).info()).version).toBe("2.2.7-mock");
    expect(logs.join("\n")).not.toContain(conn.password!);
    // ensure() is idempotent
    expect(await server.ensure()).toBe(conn);
  });

  it("reports notInstalled when the executable is missing", async () => {
    const { server } = make("/definitely/not/here/opencode");
    await expect(server.ensure()).rejects.toMatchObject({ kind: "notInstalled" });
    expect(server.state.status).toBe("failed");
  });

  it("reports startFailed with stderr when the process exits during startup", async () => {
    const { server } = make(fakeOpencode("MOCK_FAIL_START=1"));
    const err = await server.ensure().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "startFailed" });
    expect((err as { detail?: string }).detail).toContain("simulated startup failure");
  });

  it("redacts the password from stderr before exposing it as error detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fake-"));
    const file = join(dir, "opencode");
    writeFileSync(file, '#!/bin/sh\necho "server password $OPENCODE_PASSWORD leaked" >&2\nexit 1\n');
    chmodSync(file, 0o755);
    const { server } = make(file);
    const err = await server.ensure().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "startFailed" });
    const detail = (err as { detail?: string }).detail ?? "";
    expect(detail).toContain("server password ***");
    expect(detail).not.toMatch(/server password\s+[A-Za-z0-9+/=]{16,}/);
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
