import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCompatibility, SUPPORTED_SERVER_VERSION } from "../../src/shared/compatibility";

describe("checkCompatibility", () => {
  it.each([
    ["2.3.0", "ok"],
    ["v2.3.0", "ok"],
    ["2.3.0-mock", "ok"],
    ["2.3.0+build.5", "ok"],
    ["2.3.8", "ok"],
    ["2.3.1", "ok"],
    ["2.2.7", "untested"],
    ["2.4.0", "untested"],
    ["3.0.0", "unsupported"],
    ["1.9.9", "unsupported"],
    ["not-a-version", "unknown"],
    ["2.2", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const)("maps %s to %s", (version, expected) => {
    expect(checkCompatibility(version)).toBe(expected);
  });

  it("matches the OpenAPI snapshot the client types were taken from", () => {
    expect(existsSync(join(__dirname, "../../docs", `openapi-${SUPPORTED_SERVER_VERSION}.json`))).toBe(true);
  });
});
