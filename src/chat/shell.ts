/**
 * Quotes a single argument for a shell command sent to an interactive terminal. `executablePath` is
 * machine-overridable, so it can come from a workspace's settings: concatenating it into a command
 * line unsafely would let that workspace run arbitrary commands when the user clicks "Sign in".
 * POSIX uses single quotes (with the usual `'\''` escape); cmd.exe has no safe way to embed a double
 * quote, so such paths are rejected instead. The platform is a parameter so the Windows branch can
 * be tested on any host.
 */
export type ShellPlatform = NodeJS.Platform | "mac" | "windows";

export function quoteForShell(value: string, platform: ShellPlatform = process.platform): string {
  if (/[\0\r\n]/.test(value)) throw new Error("The executable path contains a control character.");
  if (platform === "win32" || platform === "windows") {
    if (/["&|<>^%!]/.test(value))
      throw new Error('The executable path contains a character cmd.exe cannot quote safely (", &, |, <, >, ^, %, !).');
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
