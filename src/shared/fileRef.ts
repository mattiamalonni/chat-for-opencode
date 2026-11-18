/**
 * Recognises plain-text file references in chat text (`src/app.ts`, `foo.ts:42`, `foo.ts#L12`).
 *
 * Shared by the webview linkifier and by tool/permission cards so they agree on what a path is.
 * Must stay DOM-free: this module is compiled both by the extension host and by the webview.
 */

const SHAPE = /^(?:[A-Za-z]:)?(?:\.{0,2}[/\\])?(?:[\w@.-]+[/\\])*[\w@.-]+\.[A-Za-z0-9]{2,8}$/;

/** Leading delimiter kept outside the link, then the reference itself. */
const IN_TEXT = /(^|[\s("'`[{])((?:[A-Za-z]:)?(?:\.{0,2}[/\\])?(?:[\w@.-]+[/\\])*[\w@.-]+\.[A-Za-z0-9]{2,8}(?::\d+(?::\d+)?)?(?:#L\d+)?)/g;

const NOT_A_FILE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i;

export interface FileRefMatch {
  /** Character offset of the reference inside the source text. */
  start: number;
  /** The reference as written, e.g. `src/app.ts:42`. */
  text: string;
}

/** `src/app.ts#L12` → `src/app.ts:12`, which the host's `openFile` already understands. */
export function fileRefToOpenPath(ref: string): string {
  return ref.replace(/#L(\d+)(?:-L?\d+)?$/i, ":$1").replace(/^\.\//, "");
}

/** True when `value` looks like a file path (optionally with a line/column). */
export function isFileRef(value: string): boolean {
  if (!value || NOT_A_FILE.test(value)) return false;
  return SHAPE.test(value.replace(/(?::\d+(?::\d+)?|#L\d+)$/i, ""));
}

/** Finds file references in a plain-text node, skipping URLs and non-path words. */
export function findFileRefs(text: string): FileRefMatch[] {
  const found: FileRefMatch[] = [];
  IN_TEXT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IN_TEXT.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const ref = match[2] ?? "";
    if (isFileRef(ref)) found.push({ start: match.index + prefix.length, text: ref });
    IN_TEXT.lastIndex = match.index + match[0].length;
  }
  return found;
}
