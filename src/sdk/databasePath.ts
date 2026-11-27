/**
 * Where OpenCode keeps its global SQLite database, resolved the way the CLI/TUI resolves it so both
 * open the same file. OpenCode uses the XDG base directories on every OS (Windows and macOS too,
 * not %APPDATA% or ~/Library), and treats an empty variable as unset.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

/** OpenCode's data directory: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function opencodeDataDir(env: Env = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
}

/**
 * The database the extension opens. `OPENCODE_DATABASE_PATH` is the extension's own override;
 * `OPENCODE_DB` is OpenCode's, honoured so a database moved for the TUI is moved here too
 * (`:memory:` and absolute paths as given, a relative name under the data directory).
 */
export function defaultDatabasePath(env: Env = process.env, home: string = homedir()): string {
  if (env.OPENCODE_DATABASE_PATH) return env.OPENCODE_DATABASE_PATH;
  const dataDir = opencodeDataDir(env, home);
  const db = env.OPENCODE_DB;
  if (db) return db === ":memory:" || isAbsolute(db) ? db : join(dataDir, db);
  return join(dataDir, "opencode.db");
}
