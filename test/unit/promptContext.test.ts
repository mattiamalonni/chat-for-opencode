import { describe, expect, it } from "vitest";
import { formatPromptDiagnostics, formatPromptDiff } from "../../src/chat/promptContext";

describe("$diff prompt variable", () => {
  it("formats the working-tree diff, its truncation flag and untracked files", () => {
    expect(formatPromptDiff({ diff: "@@ -1 +1 @@", truncated: true, untracked: ["new.ts"] })).toBe(
      "@@ -1 +1 @@\n(diff truncated)\nUntracked files: new.ts",
    );
  });

  it("explains an empty repository", () => {
    expect(formatPromptDiff({ diff: "", truncated: false, untracked: [] })).toBe("(no tracked changes)");
  });

  it("caps very long diffs", () => {
    expect(formatPromptDiff({ diff: "x".repeat(12_100), truncated: false, untracked: [] })).toContain("… truncated");
  });
});

describe("$problems prompt variable", () => {
  it("formats diagnostics with severity, path and line", () => {
    expect(formatPromptDiagnostics([{ uri: "/work/src/app.ts", startLine: 3, message: " unused import ", severity: 1 }])).toBe(
      "- Warning at /work/src/app.ts:4: unused import",
    );
  });

  it("says when there is nothing to report", () => {
    expect(formatPromptDiagnostics([])).toBe("No diagnostics reported for the active file.");
  });
});
