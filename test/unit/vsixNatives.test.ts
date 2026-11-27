import { describe, expect, it } from "vitest";

interface Family {
  name: string;
  os?: string[];
  cpu?: string[];
}
interface CheckModule {
  zipEntries(buf: Buffer): string[];
  platformFamilies(lock: unknown): Map<string, Family[]>;
  checkVsix(entries: string[], families: Map<string, Family[]>, target: string): { errors: string[]; warnings: string[] };
}

// A variable specifier keeps tsc from resolving the untyped .mjs module.
const modulePath = "../../scripts/check-vsix-natives.mjs";
const load = () => import(modulePath) as Promise<CheckModule>;

/** Central directory + end record only: all `zipEntries` reads. */
function zipOf(names: string[]): Buffer {
  const records = names.map((name) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    return Buffer.concat([header, Buffer.from(name)]);
  });
  const dir = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([dir, end]);
}

const lock = {
  packages: {
    "node_modules/@lydell/node-pty": { optionalDependencies: { "@lydell/node-pty-darwin-arm64": "1", "@lydell/node-pty-linux-x64": "1" } },
    "node_modules/@lydell/node-pty-darwin-arm64": { os: ["darwin"], cpu: ["arm64"], optional: true },
    "node_modules/@lydell/node-pty-linux-x64": { os: ["linux"], cpu: ["x64"], optional: true },
    "node_modules/@parcel/watcher-linux-x64-glibc": { os: ["linux"], cpu: ["x64"], optional: true },
    "node_modules/@parcel/watcher-linux-x64-musl": { os: ["linux"], cpu: ["x64"], optional: true },
    "node_modules/@parcel/watcher-darwin-arm64": { os: ["darwin"], cpu: ["arm64"], optional: true },
    "node_modules/esbuild-darwin": { os: ["darwin"], dev: true },
  },
};

describe("check-vsix-natives", () => {
  it("reads entry names from a zip central directory", async () => {
    const { zipEntries } = await load();
    expect(zipEntries(zipOf(["extension/package.json", "extension/dist/extension.mjs"]))).toEqual([
      "extension/package.json",
      "extension/dist/extension.mjs",
    ]);
  });

  it("accepts a package that ships exactly its own platform binaries", async () => {
    const { checkVsix, platformFamilies } = await load();
    const entries = [
      "extension/node_modules/@lydell/node-pty-linux-x64/x.node",
      "extension/node_modules/@parcel/watcher-linux-x64-glibc/w.node",
    ];
    expect(checkVsix(entries, platformFamilies(lock), "linux-x64").errors).toEqual([]);
  });

  it("rejects a wrapper without its binary and a binary of another platform", async () => {
    const { checkVsix, platformFamilies } = await load();
    const entries = ["extension/node_modules/@lydell/node-pty/index.js", "extension/node_modules/@parcel/watcher-darwin-arm64/w.node"];
    const { errors } = checkVsix(entries, platformFamilies(lock), "linux-x64");
    expect(errors).toContain("@lydell/node-pty: missing @lydell/node-pty-linux-x64");
    expect(errors).toContain("@parcel/watcher-*: missing @parcel/watcher-linux-x64-glibc");
    expect(errors).toContain("@parcel/watcher-*: ships foreign @parcel/watcher-darwin-arm64");
  });

  it("requires the musl variant for Alpine and accepts a libc-neutral one", async () => {
    const { checkVsix, platformFamilies } = await load();
    const families = platformFamilies(lock);
    const glibcOnly = [
      "extension/node_modules/@lydell/node-pty-linux-x64/x.node",
      "extension/node_modules/@parcel/watcher-linux-x64-glibc/w.node",
    ];
    expect(checkVsix(glibcOnly, families, "alpine-x64").errors).toEqual(["@parcel/watcher-*: missing @parcel/watcher-linux-x64-musl"]);
    const both = [...glibcOnly, "extension/node_modules/@parcel/watcher-linux-x64-musl/w.node"];
    expect(checkVsix(both, families, "alpine-x64").errors).toEqual([]);
  });

  it("ignores dev-only platform packages and warns when a target has no variant", async () => {
    const { checkVsix, platformFamilies } = await load();
    const families = platformFamilies(lock);
    expect([...families.values()].flat().map((p) => p.name)).not.toContain("esbuild-darwin");
    const { errors, warnings } = checkVsix([], families, "win32-x64");
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});
