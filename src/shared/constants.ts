/**
 * Runtime defaults shared across the host and its tests. The matching literals in package.json
 * cannot import TS, so a unit test asserts parity; everything in code reads these constants.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Adds ±50% jitter to a retry delay. Several VS Code windows (or an extension and a TUI) can lose
 * the same server at once; without jitter their exponential backoffs line up and hammer it on
 * every restart. The average delay stays the same.
 */
export function jitteredDelay(baseMs: number): number {
  return Math.round(baseMs * (0.5 + Math.random()));
}
