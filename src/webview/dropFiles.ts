/**
 * Turns an HTML5 drop into the data the extension host needs to attach files.
 *
 * Webviews are sandboxed, so a dropped file rarely exposes its absolute path. Depending on the
 * drag source the path is available in a URI list, in Electron's non-standard `File.path`, or not
 * at all (in which case the bytes are read and the host persists them). Kept DOM-light so the
 * parsing is unit-testable in Node; only `readFileAsBase64` needs a real browser File.
 */

import type { DroppedFile } from "../shared/protocol";

const CODE_URI_LIST = "application/vnd.code.uri-list";
const URI_LIST = "text/uri-list";

/** The slice of `DataTransfer` (and of its `File`s) that this module uses. */
export interface DropFileLike {
  name: string;
  path?: string;
  type?: string;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface DragData {
  types: readonly string[];
  getData(type: string): string;
  files: ArrayLike<DropFileLike>;
  items?: ArrayLike<{ kind: string; type: string; getAsFile?(): DropFileLike | null }>;
}

/** Reads a dropped File's content as base64 (no data-URL prefix). */
type FileReader = (file: DropFileLike) => Promise<string>;

export function hasFiles(drag: DragData | undefined | null): boolean {
  if (!drag) return false;
  const types = Array.from(drag.types ?? []);
  if (types.includes("Files") || types.includes(CODE_URI_LIST) || types.includes(URI_LIST)) return true;
  if ((drag.files?.length ?? 0) > 0) return true;
  // Some webview hosts strip the type list but keep the items.
  return Array.from(drag.items ?? []).some((item) => item.kind === "file" || item.type === "Files");
}

function splitList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Parses a `text/uri-list` or VS Code's JSON-encoded `application/vnd.code.uri-list`. */
export function parseUriList(raw: string): { uri?: string; path?: string }[] {
  let lines = splitList(raw);
  if (raw.trimStart().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) lines = parsed.filter((line): line is string => typeof line === "string");
    } catch {
      // Not JSON after all: fall back to the plain list.
    }
  }
  return lines.map((line) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(line) ? { uri: line } : { path: line }));
}

function nameFrom(value: string): string {
  try {
    if (value.includes("://")) {
      const pathname = new URL(value).pathname;
      return decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? value);
    }
  } catch {
    // A malformed URI is still usable as a display name.
  }
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/?([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

/** The same dropped file can arrive as a `file://` URI and as a `File.path`; treat them as one. */
function dedupeKey(entry: DroppedFile): string {
  if (entry.path) return normalizePath(entry.path);
  if (entry.uri) {
    try {
      const url = new URL(entry.uri);
      if (url.protocol === "file:") return normalizePath(decodeURIComponent(url.pathname));
    } catch {
      // Fall through to the raw URI.
    }
    return entry.uri;
  }
  return `blob:${entry.name}`;
}

/**
 * Reads all dropped files, preferring a path over content so the host can attach the original file.
 * Content is only read when no path could be recovered from any source.
 */
export async function collectDroppedFiles(drag: DragData, readFile: FileReader): Promise<DroppedFile[]> {
  const entries: DroppedFile[] = [];
  const seen = new Set<string>();
  const push = (entry: DroppedFile) => {
    const key = dedupeKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const type of [CODE_URI_LIST, URI_LIST]) {
    const raw = drag.getData(type);
    if (!raw) continue;
    for (const parsed of parseUriList(raw)) {
      push({ name: nameFrom(parsed.uri ?? parsed.path ?? ""), ...parsed });
    }
  }

  const files = Array.from(drag.files ?? []);
  for (const file of files) {
    if (file.path) {
      push({ name: file.name, path: file.path });
    } else {
      // A mixed drop can contain path-bearing files and clipboard/browser files that only carry
      // bytes. Decide per file: gating all reads on `entries.length === 0` silently dropped them.
      try {
        const entry: DroppedFile = { name: file.name, base64: await readFile(file) };
        if (file.type) entry.mime = file.type;
        push(entry);
      } catch {
        // An unreadable file must not prevent the other files from being attached.
      }
    }
  }
  return entries;
}

/**
 * Reads files pasted into the composer (typically an image from the clipboard). Clipboard files
 * carry no path, so their bytes are always sent inline. `DataTransfer.files` covers most hosts;
 * some only expose the file through `items[].getAsFile()`, so fall back to that.
 */
export async function collectPastedFiles(drag: DragData, readFile: FileReader): Promise<DroppedFile[]> {
  const files: DropFileLike[] = Array.from(drag.files ?? []);
  if (files.length === 0) {
    for (const item of Array.from(drag.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
  }
  const entries: DroppedFile[] = [];
  for (const file of files) {
    try {
      const entry: DroppedFile = { name: file.name, base64: await readFile(file) };
      if (file.type) entry.mime = file.type;
      entries.push(entry);
    } catch {
      // An unreadable file must not prevent the other files from being attached.
    }
  }
  return entries;
}

export async function readFileAsBase64(file: DropFileLike): Promise<string> {
  if (!file.arrayBuffer) throw new Error("Dropped file content is not readable");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
