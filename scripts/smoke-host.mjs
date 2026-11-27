/**
 * Starts the embedded OpenCode host from an unpacked VSIX, the way the extension does on first
 * connect, and opens a pty with the shipped node-pty binary. `verify:vsix` proves the right files
 * are in the package; this proves they load on the machine (or container) running it.
 *
 *   node scripts/smoke-host.mjs <file.vsix | unpacked-vsix/extension> [--no-pty]
 *
 * A .vsix is unpacked to a temporary folder first (stdlib zlib, Unix modes kept: node-pty's
 * spawn-helper must stay executable), so the check runs the same way on every CI runner.
 * `--no-pty` skips the terminal check where node-pty has no binary for the platform (musl).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const [dirArg, ...flags] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: node scripts/smoke-host.mjs <file.vsix | unpacked-vsix/extension> [--no-pty]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "oc-smoke-"));

/** Extracts a zip archive (stored or deflated entries) into `out`. */
function unzip(file, out) {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip archive`);
  const root = resolve(out);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const target = resolve(root, name);
    if (!target.startsWith(root + sep)) throw new Error(`unsafe entry name ${name}`);
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, method === 8 ? inflateRawSync(raw) : raw);
    if (process.platform !== "win32" && mode & 0o777) chmodSync(target, mode & 0o777);
  }
}

let dir = resolve(dirArg);
if (statSync(dir).isFile()) {
  unzip(dir, join(scratch, "vsix"));
  dir = join(scratch, "vsix", "extension");
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

async function checkHost() {
  const started = performance.now();
  const bridge = await import(pathToFileURL(join(dir, "dist", "sdk.mjs")).href);
  const host = await withTimeout(bridge.createHost({ databasePath: join(scratch, "opencode.db") }), 60_000, "createHost");
  try {
    await withTimeout(host.server.info(), 30_000, "server.info");
  } finally {
    await host.close?.();
  }
  console.log(`embedded host started and answered in ${Math.round(performance.now() - started)} ms`);
}

async function checkPty() {
  const pty = createRequire(join(dir, "package.json"))("@lydell/node-pty");
  const term = pty.spawn(process.execPath, ["-e", "process.stdout.write('pty-ok')"], { cols: 80, rows: 24 });
  let output = "";
  term.onData((data) => (output += data));
  await withTimeout(new Promise((done) => term.onExit(done)), 30_000, "pty");
  if (!output.includes("pty-ok")) throw new Error(`pty output did not contain the marker: ${JSON.stringify(output)}`);
  console.log("node-pty spawned a process and read its output");
}

try {
  await checkHost();
  if (!flags.includes("--no-pty")) await checkPty();
  console.log(`${dir}: smoke test passed on ${process.platform}-${process.arch}`);
} catch (err) {
  console.error(`smoke test failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// The host may leave timers or watchers behind after close(); the result is already decided.
process.exit(process.exitCode ?? 0);
