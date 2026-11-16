/**
 * Version of OpenCode whose API contract this extension was built against (types from
 * docs/openapi-2.2.7.json and the recorded SSE fixtures). Keep in sync with that snapshot.
 */
export const SUPPORTED_SERVER_VERSION = "2.2.7";

export type Compatibility = "ok" | "untested" | "unsupported" | "unknown";

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** `2.2.7-mock` and `v2.2.7+build` are still 2.2.7 for our purposes. */
function core(version: string): { major: number; minor: number } | undefined {
  const m = VERSION.exec(version.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

/**
 * The server is the source of truth, but only the tested contract is known to work. Patch releases
 * of the tested minor are treated as compatible (OpenCode ships them very often, and warning on
 * each would teach users to ignore the banner); another minor has not been verified; another major
 * is likely incompatible.
 */
export function checkCompatibility(version?: string): Compatibility {
  if (!version) return "unknown";
  const actual = core(version);
  const expected = core(SUPPORTED_SERVER_VERSION)!;
  if (!actual) return "unknown";
  if (actual.major !== expected.major) return "unsupported";
  return actual.minor === expected.minor ? "ok" : "untested";
}
