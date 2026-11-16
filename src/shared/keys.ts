export interface KeyLike {
  key: string;
  keyCode?: number;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export type Platform = "mac" | "windows" | "linux";

/** True while an IME composition is in progress (including the WebKit/Windows quirks). */
export function isImeKey(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229 || e.key === "Process";
}

/**
 * Keys that must keep reaching VS Code even when the chat composer has focus.
 * Clipboard/undo are included because the webview preload implements them for Electron.
 */
function isPassthrough(e: KeyLike, platform: Platform): boolean {
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (/^F\d{1,2}$/.test(e.key)) return true;
  if (!mod || e.altKey) {
    // Ctrl+` (toggle terminal) on every platform.
    return e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Backquote";
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey) return k === "p" || k === "z" || k === "e" || k === "f" || k === "x";
  return ["c", "v", "x", "z", "y", "p", "s", "w", "q", "n", ",", "b"].includes(k) || e.key === "Insert";
}

/**
 * Whether a keydown inside the composer must be stopped before it bubbles to `window`, where the
 * VS Code webview preload forwards it to the workbench keybinding service. Without this, chords
 * like Ctrl+J (toggle panel), Ctrl+R (recent) or AltGr characters on Windows would trigger
 * VS Code commands while typing.
 */
export function shouldIsolateKey(e: KeyLike, platform: Platform): boolean {
  if (isImeKey(e)) return true;
  if (e.key === "Escape" || e.key === "Tab") return false;
  if (e.key === "CapsLock") return true;
  return !isPassthrough(e, platform);
}

export type ComposerAction = "send" | "newline" | "none";

/** Enter sends, Shift+Enter inserts a newline; never send while composing with an IME. */
export function composerAction(e: KeyLike, composing: boolean): ComposerAction {
  if (e.key !== "Enter") return "none";
  if (composing || isImeKey(e)) return "none";
  if (e.shiftKey || e.altKey) return "newline";
  return "send";
}
