/**
 * Checks that a platform-specific VSIX ships the native binaries of its own target, and none of
 * another platform. npm installs optional platform packages only for the host it runs on, so a
 * VSIX packaged on the wrong runner (or as a universal package) silently lacks them.
 *
 *   node scripts/check-vsix-natives.mjs <file.vsix> [target]
 *
 * `target` is a `vsce --target` value; it defaults to the current host.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_MODULES } from "./external-modules.mjs";

const TARGETS = {
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "alpine-x64": { os: "linux", cpu: "x64", libc: "musl" },
  "alpine-arm64": { os: "linux", cpu: "arm64", libc: "musl" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "win32-x64": { os: "win32", cpu: "x64" },
  "win32-arm64": { os: "win32", cpu: "arm64" },
};

/** Lists the entry names of a zip archive from its central directory. */
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function libcOf(name) {
  if (/musl/.test(name)) return "musl";
  if (/gnu|glibc/.test(name)) return "glibc";
  return undefined;
}

function matches(meta, target) {
  if (meta.os && !meta.os.includes(target.os)) return false;
  if (meta.cpu && !meta.cpu.includes(target.cpu)) return false;
  return true;
}

/**
 * Groups the platform packages declared in the lockfile by the external module they belong to:
 * a wildcard pattern (`@parcel/watcher-*`) or the wrapper that lists them as optional dependencies.
 */
export function platformFamilies(lock) {
  const packages = Object.entries(lock.packages ?? {})
    .filter(([key, meta]) => key.startsWith("node_modules/") && !meta.dev && (meta.os || meta.cpu))
    .map(([key, meta]) => ({ name: key.slice(key.lastIndexOf("node_modules/") + 13), os: meta.os, cpu: meta.cpu }));
  const families = new Map();
  const add = (family, pkg) => {
    if (!families.has(family)) families.set(family, new Map());
    families.get(family).set(pkg.name, pkg);
  };
  for (const pattern of EXTERNAL_MODULES) {
    if (pattern.includes("*")) {
      const prefix = pattern.split("*")[0];
      for (const pkg of packages) if (pkg.name.startsWith(prefix)) add(pattern, pkg);
    } else {
      const wrapper = lock.packages[`node_modules/${pattern}`];
      for (const dep of Object.keys(wrapper?.optionalDependencies ?? {})) {
        const pkg = packages.find((p) => p.name === dep);
        if (pkg) add(pattern, pkg);
      }
    }
  }
  return new Map([...families].map(([k, v]) => [k, [...v.values()]]));
}

export function checkVsix(entries, families, targetName) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target ${targetName}; expected one of ${Object.keys(TARGETS).join(", ")}`);
  const shipped = (name) => entries.some((e) => e.startsWith(`extension/node_modules/${name}/`));
  const errors = [];
  const warnings = [];
  for (const [family, pkgs] of families) {
    const own = pkgs.filter((p) => matches(p, target));
    // Prefer the variant for the target's libc; a libc-neutral package also qualifies.
    const preferred = own.filter((p) => !target.libc || !libcOf(p.name) || libcOf(p.name) === target.libc);
    if (preferred.length === 0) warnings.push(`${family}: no package declared for ${targetName}`);
    else if (!preferred.some((p) => shipped(p.name))) errors.push(`${family}: missing ${preferred.map((p) => p.name).join(" or ")}`);
    for (const p of pkgs) if (!matches(p, target) && shipped(p.name)) errors.push(`${family}: ships foreign ${p.name}`);
  }
  return { errors, warnings };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [file, targetArg] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/check-vsix-natives.mjs <file.vsix> [target]");
    process.exit(2);
  }
  const target = targetArg ?? `${process.platform}-${process.arch}`;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const { errors, warnings } = checkVsix(zipEntries(readFileSync(file)), platformFamilies(lock), target);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`${file} is not a valid ${target} package.`);
    process.exit(1);
  }
  console.log(`${file}: native binaries match ${target}.`);
}
