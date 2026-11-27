import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCompatibility, compatibilityKey, SUPPORTED_SERVER_VERSION } from "../../src/shared/compatibility";

describe("checkCompatibility", () => {
  it.each([
    ["2.4.0", "ok"],
    ["v2.4.0", "ok"],
    ["2.4.0-mock", "ok"],
    ["2.4.0+build.5", "ok"],
    ["2.4.8", "ok"],
    ["2.4.1", "ok"],
    ["2.3.0", "untested"],
    ["2.5.0", "untested"],
    ["3.0.0", "unsupported"],
    ["1.9.9", "unsupported"],
    ["not-a-version", "unknown"],
    ["2.2", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const)("maps %s to %s", (version, expected) => {
    expect(checkCompatibility(version)).toBe(expected);
  });

  it("keys dismissals by minor series, so patch upgrades keep them", () => {
    expect(compatibilityKey("2.4.0")).toBe("2.4");
    expect(compatibilityKey("v2.4.7+build.3")).toBe("2.4");
    expect(compatibilityKey("2.3.0-mock")).toBe("2.3");
    expect(compatibilityKey("3.0.1")).toBe("3.0");
    expect(compatibilityKey("not-a-version")).toBeUndefined();
    expect(compatibilityKey(undefined)).toBeUndefined();
  });

  it("matches the OpenAPI snapshot the client types were taken from", () => {
    expect(existsSync(join(__dirname, "../../docs", `openapi-${SUPPORTED_SERVER_VERSION}.json`))).toBe(true);
  });
});

describe("embedded host version", () => {
  // src/sdk/bridge.ts reports the pinned `@opencode/sdk` spec as the host's version: the OpenCode
  // gateway refuses free models to a client whose version is `unknown`, so the spec must be the
  // exact installed version, not a range.
  it("pins @opencode/sdk to the exact installed version", () => {
    const root = join(__dirname, "../..");
    const spec = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@opencode/sdk"];
    const installed = JSON.parse(readFileSync(join(root, "node_modules/@opencode/sdk/package.json"), "utf8")).version;
    expect(spec).toBe(installed);
  });
});
