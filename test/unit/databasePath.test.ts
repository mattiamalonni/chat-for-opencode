import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDatabasePath, opencodeDataDir } from "../../src/sdk/databasePath";

const home = join("/", "home", "me");
const shareDir = join(home, ".local", "share", "opencode");

describe("OpenCode database path", () => {
  it("uses ~/.local/share/opencode/opencode.db by default, like the TUI", () => {
    expect(defaultDatabasePath({}, home)).toBe(join(shareDir, "opencode.db"));
  });

  it("follows XDG_DATA_HOME", () => {
    const xdg = join("/", "xdg");
    expect(defaultDatabasePath({ XDG_DATA_HOME: xdg }, home)).toBe(join(xdg, "opencode", "opencode.db"));
  });

  it("treats an empty XDG_DATA_HOME as unset instead of resolving a relative path", () => {
    expect(opencodeDataDir({ XDG_DATA_HOME: "" }, home)).toBe(shareDir);
    expect(defaultDatabasePath({ XDG_DATA_HOME: "" }, home)).toBe(join(shareDir, "opencode.db"));
  });

  it("honours OpenCode's OPENCODE_DB: absolute as given, relative under the data dir", () => {
    const abs = join("/", "elsewhere", "oc.db");
    expect(defaultDatabasePath({ OPENCODE_DB: abs }, home)).toBe(abs);
    expect(defaultDatabasePath({ OPENCODE_DB: "custom.db" }, home)).toBe(join(shareDir, "custom.db"));
    expect(defaultDatabasePath({ OPENCODE_DB: ":memory:" }, home)).toBe(":memory:");
  });

  it("lets the extension's OPENCODE_DATABASE_PATH override everything", () => {
    expect(defaultDatabasePath({ OPENCODE_DATABASE_PATH: "/x.db", OPENCODE_DB: "/y.db", XDG_DATA_HOME: "/z" }, home)).toBe(
      "/x.db",
    );
  });
});
