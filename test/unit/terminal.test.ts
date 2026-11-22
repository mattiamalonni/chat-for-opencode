import { describe, expect, it } from "vitest";

import { openSessionCommand } from "../../src/chat/terminal";

describe("openSessionCommand", () => {
  it("resumes the current session on POSIX shells", () => {
    expect(openSessionCommand("opencode", "session-42", "linux")).toBe("'opencode' --session 'session-42'");
    expect(openSessionCommand("opencode", "session-42", "mac")).toBe("'opencode' --session 'session-42'");
  });

  it("starts a fresh TUI when there is no session yet", () => {
    expect(openSessionCommand("opencode", undefined, "linux")).toBe("'opencode'");
  });

  it("quotes paths with spaces and single quotes", () => {
    expect(openSessionCommand("/Applications/My App/opencode", "s1", "linux")).toBe("'/Applications/My App/opencode' --session 's1'");
    expect(openSessionCommand("/tmp/it's/opencode", "s1", "linux")).toBe("'/tmp/it'\\''s/opencode' --session 's1'");
  });

  it("uses double quotes on Windows", () => {
    expect(openSessionCommand("C:\\Program Files\\opencode.exe", "s1", "windows")).toBe('"C:\\Program Files\\opencode.exe" --session "s1"');
  });

  it("rejects values that cannot be quoted safely", () => {
    expect(() => openSessionCommand("echo $(rm -rf /)", "s1", "linux")).not.toThrow();
    expect(() => openSessionCommand("opencode\nrm -rf /", "s1", "linux")).toThrow(/control character/);
    expect(() => openSessionCommand("opencode && rm", "s1", "windows")).toThrow(/cmd.exe/);
  });
});
