/**
 * Filesystem containment that survives symlinks.
 *
 * `isWithinDirectory()` only compares resolved strings. A link inside the workspace that points at
 * `/etc` passes that check, so `openFile`, diff rendering and attachments could read — and even send
 * to the model — a file the user never allowed. Resolve real paths before every containment decision.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isWithinDirectory } from "./tempAttachments";

/** Resolve a path through symlinks, using the deepest existing ancestor for not-yet-created files. */
async function realAncestor(file: string): Promise<string | undefined> {
  let current = path.resolve(file);
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      // Missing file: check its parent. Any other failure (permissions, I/O) is a hard no.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** True when `file` really lives in `dir`, after resolving links on both sides. */
export async function isWithinDirectoryReal(file: string, dir: string): Promise<boolean> {
  const [target, root] = await Promise.all([realAncestor(file), realAncestor(dir)]);
  if (target === undefined || root === undefined) return false;
  return isWithinDirectory(target, root);
}
