import { OPENAPI_SNAPSHOT_VERSION } from "./openapi.generated";

/**
 * Version of OpenCode whose API contract this extension was built against. The generated module
 * derives it from the OpenAPI snapshot file name, so this is the single source of truth: upgrading
 * the snapshot is the one place that needs to change.
 */
export const SUPPORTED_SERVER_VERSION = OPENAPI_SNAPSHOT_VERSION;

export type Compatibility = "ok" | "untested" | "unsupported" | "unknown";

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** `2.3.0-mock` and `v2.3.0+build` are still 2.3.0 for our purposes. */
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
