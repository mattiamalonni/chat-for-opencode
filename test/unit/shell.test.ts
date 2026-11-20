import { describe, expect, it } from "vitest";
import { quoteForShell } from "../../src/chat/shell";

describe("quoteForShell", () => {
  it("single-quotes POSIX paths and escapes embedded quotes", () => {
    expect(quoteForShell("/usr/bin/opencode", "linux")).toBe("'/usr/bin/opencode'");
    expect(quoteForShell("/opt/my tools/opencode", "linux")).toBe("'/opt/my tools/opencode'");
    expect(quoteForShell("/opt/o'code", "linux")).toBe(`'/opt/o'\\''code'`);
  });

  it("double-quotes clean Windows paths and rejects cmd.exe metacharacters", () => {
    expect(quoteForShell("C:\\Program Files\\opencode\\opencode.cmd", "win32")).toBe('"C:\\Program Files\\opencode\\opencode.cmd"');
    for (const bad of ['C:\\bad"path', "C:\\a&b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\a^b", "C:\\a%b", "C:\\a!b"]) {
      expect(() => quoteForShell(bad, "win32")).toThrow(/cmd.exe/);
    }
  });

  it("rejects control characters on every platform", () => {
    for (const platform of ["win32", "linux", "mac"] as const) {
      for (const bad of ["a\0b", "a\rb", "a\nb"]) expect(() => quoteForShell(bad, platform)).toThrow(/control character/);
    }
  });
});
