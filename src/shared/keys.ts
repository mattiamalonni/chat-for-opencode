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
 * Clipboard/undo/select-all are included because VS Code implements them for Electron: the preload
 * forwards them and `SelectAllCommand` calls `webview.selectAll()` → `execCommand('selectAll')`.
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
  // "a" is Select All on the platform's primary modifier (Cmd on mac, Ctrl elsewhere). On mac
  // Ctrl+A is Emacs "beginning of line" and never gets here: `mod` is false, so it stays isolated.
  return ["a", "c", "v", "x", "z", "y", "p", "s", "w", "q", "n", ",", "b"].includes(k) || e.key === "Insert";
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

/** Plain Cmd (mac) / Ctrl (Windows/Linux) + one letter, with no extra modifiers or IME composition. */
function isPlainChord(e: KeyLike, platform: Platform, letter: string): boolean {
  if (isImeKey(e) || e.altKey || e.shiftKey) return false;
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.key.toLowerCase() === letter;
}

/**
 * Cmd+N (mac) / Ctrl+N (Windows/Linux), plain and outside an IME composition: starts a new chat
 * session while the webview has focus. VS Code's workbench would otherwise turn it into a new file.
 */
export function isNewSessionKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "n");
}

/**
 * Cmd+F (mac) / Ctrl+F (Windows/Linux), plain and outside an IME composition: opens the chat's
 * message search while the webview has focus, instead of VS Code's editor find widget.
 */
export function isFindKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "f");
}

/**
 * Cmd+R (mac) / Ctrl+R (Windows/Linux), plain and outside an IME composition: re-syncs the current
 * session from the server while the webview has focus, instead of VS Code's "Open Recent".
 */
export function isSyncKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "r");
}

/**
 * Cmd+L (mac) / Ctrl+L (Windows/Linux), plain and outside an IME composition: toggles the in-chat
 * session list while the webview has focus, instead of VS Code's "Expand Line Selection".
 */
export function isOpenSessionsKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "l");
}

/**
 * Cmd+M (mac) / Ctrl+M (Windows/Linux), plain and outside an IME composition: opens the composer's
 * model picker while the webview has focus, instead of VS Code's "Toggle Tab Focus Mode".
 */
export function isOpenModelsKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "m");
}

/**
 * Cmd+G (mac) / Ctrl+G (Windows/Linux), plain and outside an IME composition: opens the session
 * timeline while the chat has focus. The capture-phase listener in the webview intercepts it before
 * VS Code can turn it into "Go to Line/Column".
 */
export function isTimelineKey(e: KeyLike, platform: Platform): boolean {
  return isPlainChord(e, platform, "g");
}

type ComposerAction = "send" | "steer" | "newline" | "none";

/**
 * Enter sends (or queues while the agent is busy), Shift/Alt+Enter inserts a newline,
 * Ctrl/Cmd+Enter steers: interrupt the current answer and send this one. Never send during IME.
 */
export function composerAction(e: KeyLike, composing: boolean): ComposerAction {
  if (e.key !== "Enter") return "none";
  if (composing || isImeKey(e)) return "none";
  if (e.shiftKey || e.altKey) return "newline";
  if (e.ctrlKey || e.metaKey) return "steer";
  return "send";
}
