import { describe, expect, it } from "vitest";
import manifest from "../../package.json";
import { DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS } from "../../src/shared/constants";
import { SUPPORTED_SERVER_VERSION } from "../../src/shared/compatibility";
import { OPENAPI_SNAPSHOT_VERSION } from "../../src/shared/openapi.generated";

describe("shared runtime defaults", () => {
  it("keeps the startup timeout in sync with the setting shipped in package.json", () => {
    const setting = manifest.contributes.configuration.properties["opencode.startupTimeout"];
    expect(setting.default).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
  });

  it("keeps the supported version in sync with the generated OpenAPI snapshot", () => {
    expect(SUPPORTED_SERVER_VERSION).toBe(OPENAPI_SNAPSHOT_VERSION);
  });

  it("uses a positive HTTP request timeout", () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
