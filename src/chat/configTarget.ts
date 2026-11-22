/**
 * The config-document paths reported by `GET /config` are server data, not local configuration: a
 * remote or compromised server can return any absolute path. Only OpenCode config files inside the
 * workspace may be opened — and, when missing, created — by `openConfigFile()`.
 */
import * as path from "node:path";
import type { ConfigEntry } from "../shared/api";
import { isWithinDirectory } from "./tempAttachments";

const CONFIG_NAMES = new Set(["opencode.json", "opencode.jsonc"]);

/** Lexically valid config paths from a server response, in the order reported. */
export function configTargetPaths(entries: readonly ConfigEntry[], directory: string): string[] {
  const targets: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "document" || typeof entry.path !== "string" || !entry.path) continue;
    const candidate = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(directory, entry.path);
    const parts = path.relative(directory, candidate).split(path.sep);
    // Only the workspace root and `.opencode/` are real OpenCode config locations. A file named
    // `opencode.json` anywhere else (e.g. `src/`) is not the document this command should open.
    const atRoot = parts.length === 1 && CONFIG_NAMES.has(parts[0].toLowerCase());
    const inConfigDir = parts[0] === ".opencode" && parts.length >= 2 && CONFIG_NAMES.has(parts.at(-1)!.toLowerCase());
    if (!atRoot && !inConfigDir) continue;
    if (!isWithinDirectory(candidate, directory)) continue;
    targets.push(candidate);
  }
  return targets;
}
