import { describe, expect, it } from "vitest";
import { applyPatch, parseHunks, sidesFromPatch } from "../../src/shared/patch";

// Real patches recorded from opencode serve 2.2.7.
const TOOL_PATCH = "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
const GIT_PATCH = "diff --git a/a.txt b/a.txt\nindex 7898192..6178079 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";

describe("patch", () => {
  it("parses tool-style and git-style hunks", () => {
    expect(parseHunks(TOOL_PATCH)).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }]);
    expect(parseHunks(GIT_PATCH)[0].lines).toEqual(["-a", "+b"]);
  });

  it("applies forward (proposed change) and reverse (reconstruct original)", () => {
    expect(applyPatch("a\n", TOOL_PATCH)).toBe("b\n");
    expect(applyPatch("b\n", GIT_PATCH, { reverse: true })).toBe("a\n");
  });

  it("handles multiple hunks with context and offset drift", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    const patch = [
      "--- f",
      "+++ f",
      "@@ -2,3 +2,3 @@",
      " line2",
      "-line3",
      "+LINE3",
      " line4",
      "@@ -15,3 +15,4 @@",
      " line15",
      " line16",
      "+inserted",
      " line17",
      "",
    ].join("\n");
    const after = applyPatch(before, patch)!;
    expect(after).toContain("LINE3\nline4");
    expect(after).toContain("line16\ninserted\nline17");
    expect(applyPatch(after, patch, { reverse: true })).toBe(before);
    // A line inserted at the top shifts everything: the patch must still apply.
    expect(applyPatch("header\n" + before, patch)).toContain("LINE3");
  });

  it("creates and deletes whole files", () => {
    const add = "--- /dev/null\n+++ new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n";
    expect(applyPatch("", add)).toBe("x\ny\n");
    expect(applyPatch("x\ny\n", add, { reverse: true })).toBe("");
  });

  it("respects '\\ No newline at end of file'", () => {
    const p = "--- f\n+++ f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    expect(applyPatch("old", p)).toBe("new");
  });

  it("preserves CRLF line endings", () => {
    expect(applyPatch("a\r\nz\r\n", "@@ -1,1 +1,1 @@\n-a\n+b\n")).toBe("b\r\nz\r\n");
  });

  it("returns undefined when the content does not match", () => {
    expect(applyPatch("something else\n", TOOL_PATCH)).toBeUndefined();
  });

  it("derives both sides from the patch alone", () => {
    expect(sidesFromPatch(TOOL_PATCH)).toEqual({ before: "a", after: "b" });
  });
});
