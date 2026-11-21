import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reads: [] as string[],
  diffs: [] as Array<{ left: unknown; right: unknown }>,
}));

vi.mock("vscode", async () => {
  const nodePath = await import("node:path");
  const uri = (fsPath: string) => ({
    fsPath,
    toString: () => `file://${fsPath}`,
    with: () => uri(fsPath),
  });
  return {
    Uri: {
      file: (file: string) => uri(file),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(nodePath.join(base.fsPath, ...parts)),
      from: ({ path: virtualPath, query }: { path: string; query: string }) => ({
        ...uri(virtualPath),
        toString: () => `opencode-diff:${virtualPath}?${query}`,
      }),
    },
    workspace: {
      fs: {
        readFile: async (target: { fsPath: string }) => {
          state.reads.push(target.fsPath);
          return new TextEncoder().encode("hello\n");
        },
      },
      textDocuments: [],
    },
    commands: {
      executeCommand: async (_command: string, left: unknown, right: unknown) => {
        state.diffs.push({ left, right });
      },
    },
    l10n: { t: (s: string) => s },
  };
});

import { DiffService } from "../../src/chat/diff";

describe("DiffService workspace containment", () => {
  const root = { fsPath: "/workspace/project" };
  const patch = "@@ -1 +1 @@\n-hello\n+world\n";

  it("refuses an absolute path outside the workspace", async () => {
    state.reads.length = 0;
    state.diffs.length = 0;
    const warn = vi.fn();
    await new DiffService(warn).open(root as never, "/etc/passwd", patch, true);
    expect(state.reads).toEqual([]);
    expect(state.diffs).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("refuses a relative path that escapes with ..", async () => {
    state.reads.length = 0;
    state.diffs.length = 0;
    const warn = vi.fn();
    await new DiffService(warn).open(root as never, "../secret.txt", patch, true);
    expect(state.reads).toEqual([]);
    expect(state.diffs).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reads and diffs a file inside the workspace", async () => {
    state.reads.length = 0;
    state.diffs.length = 0;
    const warn = vi.fn();
    await new DiffService(warn).open(root as never, "src/a.txt", patch, true);
    expect(state.reads).toEqual(["/workspace/project/src/a.txt"]);
    expect(state.diffs).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
