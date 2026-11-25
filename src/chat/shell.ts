/**
 * Quotes a single argument for a provider command shown in an interactive terminal. Command parts
 * come from OpenCode's integration configuration, which can be changed outside the extension, so a
 * part must never break out into shell syntax when the user runs "Sign in".
 * POSIX uses single quotes (with the usual `'\''` escape); cmd.exe has no safe way to embed a double
 * quote, so such parts are rejected instead. The platform is a parameter so the Windows branch is
 * testable on any host.
 */
export type ShellPlatform = NodeJS.Platform | "mac" | "windows";

export function quoteForShell(value: string, platform: ShellPlatform = process.platform): string {
  if (/[\0\r\n]/.test(value)) throw new Error("The command part contains a control character.");
  if (platform === "win32" || platform === "windows") {
    if (/["&|<>^%!]/.test(value))
      throw new Error('The command part contains a character cmd.exe cannot quote safely (", &, |, <, >, ^, %, !).');
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
