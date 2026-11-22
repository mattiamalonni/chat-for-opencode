import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigEntry } from "../../src/shared/api";
import { configTargetPaths } from "../../src/chat/configTarget";

const dir = path.resolve("/work/project");
const doc = (p: string): ConfigEntry => ({ type: "document", path: p, info: {} }) as ConfigEntry;

describe("config document paths from the server", () => {
  it("accepts workspace config documents, absolute or relative", () => {
    expect(configTargetPaths([doc(path.join(dir, "opencode.json"))], dir)).toEqual([path.join(dir, "opencode.json")]);
    expect(configTargetPaths([doc("opencode.jsonc")], dir)).toEqual([path.join(dir, "opencode.jsonc")]);
    expect(configTargetPaths([doc(".opencode/opencode.json")], dir)).toEqual([path.join(dir, ".opencode", "opencode.json")]);
  });

  it("rejects arbitrary absolute paths, traversal and unrelated file names", () => {
    expect(configTargetPaths([doc("/etc/passwd.json")], dir)).toEqual([]);
    expect(configTargetPaths([doc(path.join(dir, "..", "victim", "opencode.json"))], dir)).toEqual([]);
    expect(configTargetPaths([doc("secrets.txt")], dir)).toEqual([]);
    expect(configTargetPaths([doc(path.join(dir, "src", "opencode.json"))], dir)).toEqual([]);
    expect(configTargetPaths([{ type: "directory", path: "opencode.json" } as ConfigEntry], dir)).toEqual([]);
  });

  it("keeps only valid candidates when the response mixes good and bad entries", () => {
    const entries = [doc("/tmp/evil.json"), doc("opencode.json"), doc("../../outside/opencode.jsonc"), doc("opencode.jsonc")];
    expect(configTargetPaths(entries, dir)).toEqual([path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]);
  });
});
