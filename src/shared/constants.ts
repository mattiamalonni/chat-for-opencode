/**
 * Retry timing shared across the host and its tests.
 */

/**
 * Adds ±50% jitter to a retry delay. Several VS Code windows (or an extension and a TUI) can lose
 * the same server at once; without jitter their exponential backoffs line up and hammer it on
 * every restart. The average delay stays the same.
 */
export function jitteredDelay(baseMs: number): number {
  return Math.round(baseMs * (0.5 + Math.random()));
}
