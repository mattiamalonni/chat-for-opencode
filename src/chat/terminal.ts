import { quoteForShell, type ShellPlatform } from "./shell";

/**
 * The command typed into the integrated terminal. OpenCode's CLI shares sessions through its own
 * on-disk storage, so `--session <id>` resumes exactly the conversation shown in the chat; with no
 * session yet it simply starts a fresh TUI in the workspace folder.
 */
export function openSessionCommand(executable: string, sessionId: string | undefined, platform?: ShellPlatform): string {
  const exe = quoteForShell(executable, platform);
  return sessionId ? `${exe} --session ${quoteForShell(sessionId, platform)}` : exe;
}
