import { describe, expect, it } from "vitest";
import { commandLine, quoteArg, shellSyntax } from "../../src/chat/shell";

describe("shellSyntax", () => {
  it("follows the detected shell, not the OS", () => {
    expect(shellSyntax("pwsh", "linux")).toBe("pwsh");
    expect(shellSyntax("cmd", "win32")).toBe("cmd");
    expect(shellSyntax("gitbash", "win32")).toBe("posix");
    expect(shellSyntax("zsh", "darwin")).toBe("posix");
  });

  it("falls back to the platform's default terminal when the shell is unknown", () => {
    expect(shellSyntax(undefined, "win32")).toBe("pwsh");
    expect(shellSyntax("nu", "windows")).toBe("pwsh");
    expect(shellSyntax(undefined, "linux")).toBe("posix");
    expect(shellSyntax(undefined, "mac")).toBe("posix");
  });
});

describe("quoteArg", () => {
  it("single-quotes POSIX paths and escapes embedded quotes", () => {
    expect(quoteArg("/usr/bin/opencode", "posix")).toBe("'/usr/bin/opencode'");
    expect(quoteArg("/opt/my tools/opencode", "posix")).toBe("'/opt/my tools/opencode'");
    expect(quoteArg("/opt/o'code", "posix")).toBe(`'/opt/o'\\''code'`);
    expect(quoteArg("$(rm -rf ~)", "posix")).toBe("'$(rm -rf ~)'");
  });

  it("uses literal single-quoted strings in PowerShell", () => {
    expect(quoteArg("C:\\Program Files\\opencode\\opencode.cmd", "pwsh")).toBe("'C:\\Program Files\\opencode\\opencode.cmd'");
    expect(quoteArg("$(calc)", "pwsh")).toBe("'$(calc)'");
    expect(quoteArg("a`b", "pwsh")).toBe("'a`b'");
    expect(quoteArg("it's", "pwsh")).toBe("'it''s'");
    expect(quoteArg("it\u2019s", "pwsh")).toBe("'it\u2019\u2019s'");
  });

  it("double-quotes clean cmd.exe arguments and rejects its metacharacters", () => {
    expect(quoteArg("C:\\Program Files\\opencode\\opencode.cmd", "cmd")).toBe('"C:\\Program Files\\opencode\\opencode.cmd"');
    for (const bad of ['C:\\bad"path', "C:\\a&b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\a^b", "C:\\a%b", "C:\\a!b"]) {
      expect(() => quoteArg(bad, "cmd")).toThrow(/cmd.exe/);
    }
  });

  it("rejects control characters in every syntax", () => {
    for (const syntax of ["posix", "pwsh", "cmd"] as const) {
      for (const bad of ["a\0b", "a\rb", "a\nb"]) expect(() => quoteArg(bad, syntax)).toThrow(/control character/);
    }
  });
});

describe("commandLine", () => {
  it("prefixes PowerShell commands with the call operator", () => {
    expect(commandLine(["opencode", "auth", "login"], "pwsh")).toBe("& 'opencode' 'auth' 'login'");
    expect(commandLine(["opencode", "auth", "login"], "cmd")).toBe('"opencode" "auth" "login"');
    expect(commandLine(["opencode", "auth", "login"], "posix")).toBe("'opencode' 'auth' 'login'");
  });

  it("rejects an empty command", () => {
    expect(() => commandLine([], "posix")).toThrow(/empty/);
  });
});
