import { describe, expect, it, vi } from "vitest";

import { diffPrompt, MAX_DIFF_CHARS, workingDiff, type GitRunner } from "../../src/chat/gitDiff";

function runner(overrides: Partial<Record<string, string | Error>> = {}): GitRunner {
  return vi.fn(async (args: string[]) => {
    const key = args[0];
    if (key in overrides) {
      const value = overrides[key]!;
      if (value instanceof Error) throw value;
      return value;
    }
    if (key === "rev-parse") return "true\n";
    if (key === "diff") return "diff --git a/a.ts b/a.ts\n+changed\n";
    if (key === "ls-files") return "new.ts\nother.ts\n";
    return "";
  });
}

describe("workingDiff", () => {
  it("collects tracked changes and untracked file names", async () => {
    const result = await workingDiff("/repo", runner());
    expect(result).toMatchObject({ truncated: false, untracked: ["new.ts", "other.ts"] });
    expect(result!.diff).toContain("+changed");
  });

  it("returns undefined outside a git repository and never runs further commands", async () => {
    const run = runner({ "rev-parse": new Error("not a git repository") });
    expect(await workingDiff("/nope", run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to staged + unstaged when HEAD does not exist yet", async () => {
    const run = runner({ diff: new Error("ambiguous argument HEAD") });
    const calls: string[][] = [];
    const wrapped: GitRunner = async (args, cwd) => {
      calls.push(args);
      if (args[0] === "diff" && args.includes("HEAD")) throw new Error("no HEAD");
      if (args[0] === "diff" && args.includes("--cached")) return "staged";
      if (args[0] === "diff") return "unstaged";
      return run(args, cwd);
    };
    const result = await workingDiff("/repo", wrapped);
    expect(result!.diff).toBe("staged\nunstaged");
    expect(calls.some((a) => a.includes("HEAD"))).toBe(true);
  });

  it("truncates very large diffs and caps the untracked list", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`).join("\n");
    const result = await workingDiff("/repo", runner({ diff: "x".repeat(MAX_DIFF_CHARS + 500), "ls-files": many }));
    expect(result!.diff.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    expect(result!.truncated).toBe(true);
    expect(result!.untracked).toHaveLength(20);
  });
});

describe("diffPrompt", () => {
  const diff = { diff: "+changed", truncated: false, untracked: [] };

  it("asks for a review with concrete guidance", () => {
    const prompt = diffPrompt(diff, "review");
    expect(prompt).toMatch(/Review the uncommitted changes/);
    expect(prompt).toContain("```diff\n+changed\n```");
    expect(prompt).not.toContain("Conventional Commit");
  });

  it("asks for a Conventional Commit message without a code fence in the answer", () => {
    const prompt = diffPrompt(diff, "commit");
    expect(prompt).toMatch(/Conventional Commit message/);
    expect(prompt).toMatch(/No code fence/);
  });

  it("mentions truncation and untracked files when present", () => {
    const prompt = diffPrompt({ diff: "", truncated: true, untracked: ["a.ts", "b.ts"] }, "review");
    expect(prompt).toMatch(/truncated/);
    expect(prompt).toMatch(/Untracked files \(not in the diff\): a\.ts, b\.ts/);
    expect(prompt).toContain("(no tracked changes)");
  });
});
