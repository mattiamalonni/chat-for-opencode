import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Tracks managed `opencode serve` processes so one that survives a VS Code crash can be reaped
 * on the next start. The password is deliberately NOT persisted (it stays in memory only); the
 * record carries only the PID, port, folder and — crucially — the PID of the extension host that
 * owns the process. A live owner means another VS Code window is using that server, so it must
 * be left alone.
 */
export interface ServerRecord {
  pid: number;
  port: number;
  folder: string;
  ownerPid: number;
  startedAt: number;
}

function recordPath(dir: string, folder: string, ownerPid?: number): string {
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, 16);
  // Key by owner as well so two VS Code windows on the same folder don't overwrite each other.
  // Omitting `ownerPid` keeps the legacy (hash-only) name for cleanup of older records.
  return join(dir, ownerPid === undefined ? `${hash}.json` : `${hash}-${ownerPid}.json`);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeServerRecord(dir: string, record: ServerRecord): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(recordPath(dir, record.folder, record.ownerPid), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // A PID file is best-effort: never fail a working server because bookkeeping failed.
  }
}

export async function clearServerRecord(dir: string, folder: string, ownerPid?: number): Promise<void> {
  try {
    await fs.unlink(recordPath(dir, folder, ownerPid));
  } catch {
    // already gone
  }
}

/**
 * Confirms that `pid` is the process listening on `port`. `process.kill(pid, 0)` alone is not
 * proof: after a PID reuse it would make us kill an unrelated process. When no OS tool is
 * available we conservatively skip the reap — a leaked server is better than a wrongful kill.
 */
async function ownsPort(pid: number, port: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { timeout: 2000 });
      return stdout.split(/\r?\n/).some((line) => {
        const columns = line.trim().split(/\s+/);
        return /LISTENING/i.test(line) && (columns[1] ?? "").endsWith(`:${port}`) && columns.at(-1) === String(pid);
      });
    }
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 2000 });
    return stdout.split(/\s+/).map(Number).includes(pid);
  } catch {
    return false;
  }
}

/**
 * A 401 with OpenCode's Basic realm or a 200 whose `pid` matches the record says "OpenCode" — but
 * only together with an OS-level check that the recorded PID actually owns the port.
 */
async function looksLikeOpenCode(port: number, expectedPid: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    let shapeOk = false;
    if (res.status === 401) {
      shapeOk = /secure area/i.test(res.headers.get("www-authenticate") ?? "");
    } else if (res.ok) {
      const info = (await res.json()) as { pid?: number };
      shapeOk = info.pid === expectedPid;
    }
    return shapeOk && (await ownsPort(expectedPid, port));
  } catch {
    // not reachable / not HTTP
    return false;
  }
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      taskkill.on("error", () => resolve());
      taskkill.on("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** Removes stale records and kills only servers whose owning extension host has died. */
export async function cleanupOrphanServers(dir: string, log: (line: string) => void): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(dir, name);
        let record: ServerRecord;
        try {
          record = JSON.parse(await fs.readFile(path, "utf8")) as ServerRecord;
          if (!Number.isInteger(record.pid) || !Number.isInteger(record.port) || !Number.isInteger(record.ownerPid)) {
            throw new Error("invalid record");
          }
        } catch {
          await fs.unlink(path).catch(() => {});
          return;
        }
        if (isAlive(record.ownerPid)) {
          // Another window still owns this server: it is not an orphan.
          if (!isAlive(record.pid)) await fs.unlink(path).catch(() => {});
          return;
        }
        if (isAlive(record.pid) && (await looksLikeOpenCode(record.port, record.pid))) {
          log(`[server] reaping orphan opencode serve (pid ${record.pid}, port ${record.port}, folder ${record.folder})`);
          await killPid(record.pid);
        }
        await fs.unlink(path).catch(() => {});
      }),
  );
}
