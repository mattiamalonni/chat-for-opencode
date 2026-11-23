import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injected in unit tests so no real git process is needed. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export const MAX_DIFF_CHARS = 24_000;
const MAX_UNTRACKED = 20;

export interface WorkingDiff {
  diff: string;
  truncated: boolean;
  untracked: string[];
}

/** Runs git from the workspace folder; `undefined` means "no repository here", not an error. */
export async function workingDiff(cwd: string, run: GitRunner = defaultGitRunner): Promise<WorkingDiff | undefined> {
  try {
    await run(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    return undefined;
  }

  // `git diff HEAD` fails in a repository without commits; staged + unstaged is the equivalent there.
  let diff: string;
  try {
    diff = await run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--"], cwd);
  } catch {
    diff = [
      await run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--cached", "--"], cwd),
      await run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--"], cwd),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const untracked = (await run(["ls-files", "--others", "--exclude-standard", "--"], cwd))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated at ${MAX_DIFF_CHARS} characters)`;
  if (untracked.length > MAX_UNTRACKED) untracked.length = MAX_UNTRACKED;
  return { diff: diff.trimEnd(), truncated, untracked };
}
