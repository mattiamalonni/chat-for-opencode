import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

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

/** A 401 with OpenCode's Basic realm (or a 200 with a pid) proves the port belongs to OpenCode. */
async function looksLikeOpenCode(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    if (res.status === 401) return /secure area/i.test(res.headers.get("www-authenticate") ?? "");
    if (res.ok) {
      const info = (await res.json()) as { pid?: number };
      return typeof info.pid === "number";
    }
  } catch {
    // not reachable / not HTTP
  }
  return false;
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
        if (isAlive(record.pid) && (await looksLikeOpenCode(record.port))) {
          log(`[server] reaping orphan opencode serve (pid ${record.pid}, port ${record.port}, folder ${record.folder})`);
          await killPid(record.pid);
        }
        await fs.unlink(path).catch(() => {});
      }),
  );
}
