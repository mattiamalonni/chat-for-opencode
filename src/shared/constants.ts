/**
 * Runtime defaults shared across the host and its tests. The matching literals in package.json
 * cannot import TS, so a unit test asserts parity; everything in code reads these constants.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
