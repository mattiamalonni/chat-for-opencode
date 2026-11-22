import { describe, expect, it, vi } from "vitest";
import {
  appendOutput,
  ContextSourceService,
  contextSourceCatalog,
  formatDiagnostics,
  formatDiff,
  formatOpenEditors,
  formatSymbols,
  formatTerminal,
  inlineContext,
  stripAnsi,
  truncateContent,
  type ContextSourceHooks,
} from "../../src/chat/contextSources";

function hooks(overrides: Partial<ContextSourceHooks> = {}): ContextSourceHooks {
  return {
    t: (text) => text,
    folder: () => ({ fsPath: "/work" }) as never,
    activeEditor: () => undefined,
    visibleEditors: () => [],
    diagnostics: () => [],
    symbolsAt: async () => [],
    gitDiff: async () => undefined,
    terminal: () => undefined,
    ...overrides,
  };
}

describe("context source formatting", () => {
  it("renders diagnostics, symbols, editors, terminal and diff as compact text", () => {
    expect(formatDiagnostics([{ uri: "src/a.ts", startLine: 3, message: "bad\nthing", severity: 0 }])).toContain("Error at src/a.ts:4");
    expect(formatDiagnostics([])).toContain("No diagnostics");
    expect(formatSymbols([{ name: "foo", uri: "src/a.ts", line: 9 }])).toBe("- foo — src/a.ts:10");
    expect(formatOpenEditors([{ path: "/work/a.ts", line: 2 }, { path: "/work/b.ts" }])).toContain("/work/a.ts:3");
    expect(formatTerminal({ command: "npm test", text: "ok" })).toBe("$ npm test\nok");
    expect(formatDiff({ diff: "+a", truncated: false, untracked: ["new.ts"] })).toContain("Untracked files: new.ts");
  });

  it("caps content and produces a data URI the protocol guard accepts", () => {
    expect(truncateContent("abcdef", 3)).toContain("3 more characters");
    const item = inlineContext("git", "Git diff", "- change");
    expect(item.id).toBe("context:git");
    expect(item.kind).toBe("git");
    expect(item.uri.startsWith("data:text/markdown;base64,")).toBe(true);
    expect(Buffer.from(item.uri.split(",")[1], "base64").toString()).toBe("- change");
  });

  it("strips ANSI and keeps only the output tail", () => {
    expect(stripAnsi("\u001b[31mred\r\n")).toBe("red\n");
    expect(appendOutput("abc", "def", 4)).toBe("cdef");
  });

  it("publishes a stable catalog of all five sources", () => {
    expect(contextSourceCatalog((s) => s).map((s) => s.id)).toEqual(["problems", "git", "terminal", "openEditors", "symbol"]);
  });
});

describe("ContextSourceService", () => {
  it("builds a problems chip from diagnostics of the active file", async () => {
    const service = new ContextSourceService(
      hooks({
        activeEditor: () => ({ document: { uri: { toString: () => "file:///work/a.ts" } } }) as never,
        diagnostics: () =>
          [
            {
              uri: { toString: () => "file:///work/a.ts" },
              diagnostic: { message: "unused import", range: { start: { line: 2 } }, severity: 1 },
            },
            {
              uri: { toString: () => "file:///work/b.ts" },
              diagnostic: { message: "other file", range: { start: { line: 0 } }, severity: 0 },
            },
          ] as never,
      }),
    );
    const item = await service.build("problems");
    expect(item?.kind).toBe("problems");
    const text = Buffer.from(item!.uri.split(",")[1], "base64").toString();
    expect(text).toContain("unused import");
    expect(text).not.toContain("other file");
  });

  it("uses the working-tree diff for git and skips sources with no data", async () => {
    const gitDiff = vi.fn(async () => ({ diff: "@@ -1 +1 @@\n-a\n+b", truncated: false, untracked: [] }));
    const service = new ContextSourceService(hooks({ gitDiff }));
    const item = await service.build("git");
    expect(gitDiff).toHaveBeenCalledWith("/work");
    expect(Buffer.from(item!.uri.split(",")[1], "base64").toString()).toContain("+b");
    expect(await service.build("terminal")).toBeUndefined();
    expect(await service.build("symbol")).toBeUndefined();
  });

  it("collects visible editors and symbol definitions", async () => {
    const service = new ContextSourceService(
      hooks({
        visibleEditors: () =>
          [
            { document: { uri: { scheme: "file", fsPath: "/work/a.ts" } }, selection: { start: { line: 4 } } },
            { document: { uri: { scheme: "untitled", fsPath: "" } }, selection: { start: { line: 0 } } },
          ] as never,
        activeEditor: () => ({ document: { uri: { scheme: "file", fsPath: "/work/a.ts" } } }) as never,
        symbolsAt: async () => [{ name: "render", uri: "/work/b.ts", line: 11 }],
      }),
    );
    const editors = await service.build("openEditors");
    expect(Buffer.from(editors!.uri.split(",")[1], "base64").toString()).toContain("/work/a.ts:5");
    expect(Buffer.from(editors!.uri.split(",")[1], "base64").toString()).not.toContain("untitled");
    const symbol = await service.build("symbol");
    expect(Buffer.from(symbol!.uri.split(",")[1], "base64").toString()).toContain("render — /work/b.ts:12");
  });
});
