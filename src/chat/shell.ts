/**
 * Builds the command line for a provider command shown in an interactive terminal. Command parts
 * come from OpenCode's integration configuration, which can be changed outside the extension, so a
 * part must never break out into shell syntax when the user runs "Sign in".
 *
 * The quoting depends on the shell the terminal actually runs, not on the OS: the default terminal
 * on Windows is PowerShell, where cmd.exe-style `"…"` still expands `$(…)` and a quoted first word
 * is a string, not a command. The platform and shell are parameters so every branch is testable on
 * any host.
 */
export type ShellPlatform = NodeJS.Platform | "mac" | "windows";

/** How a command line is quoted. */
export type ShellSyntax = "posix" | "pwsh" | "cmd";

/**
 * Maps VS Code's detected shell (`TerminalState.shell`) to a quoting syntax. An unknown or not yet
 * detected shell falls back to the platform default terminal: PowerShell on Windows, a POSIX shell
 * elsewhere.
 */
export function shellSyntax(shell: string | undefined, platform: ShellPlatform = process.platform): ShellSyntax {
  if (shell === "pwsh") return "pwsh";
  if (shell === "cmd") return "cmd";
  if (shell && ["bash", "zsh", "sh", "ksh", "fish", "gitbash", "wsl"].includes(shell)) return "posix";
  return platform === "win32" || platform === "windows" ? "pwsh" : "posix";
}

/** Quotes one argument for `syntax`, or throws when it cannot be embedded safely. */
export function quoteArg(value: string, syntax: ShellSyntax): string {
  if (/[\0\r\n]/.test(value)) throw new Error("The command part contains a control character.");
  switch (syntax) {
    case "cmd":
      // cmd.exe has no safe way to embed a double quote or its metacharacters inside one.
      if (/["&|<>^%!]/.test(value))
        throw new Error('The command part contains a character cmd.exe cannot quote safely (", &, |, <, >, ^, %, !).');
      return `"${value}"`;
    case "pwsh":
      // Single-quoted strings are literal in PowerShell; it also treats typographic single quotes
      // as quote characters, so double those along with the ASCII one.
      return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
    case "posix":
      return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}

/** The full command line: in PowerShell a quoted first word needs the call operator to run. */
export function commandLine(parts: readonly string[], syntax: ShellSyntax): string {
  if (parts.length === 0) throw new Error("The command is empty.");
  const quoted = parts.map((part) => quoteArg(part, syntax)).join(" ");
  return syntax === "pwsh" ? `& ${quoted}` : quoted;
}
