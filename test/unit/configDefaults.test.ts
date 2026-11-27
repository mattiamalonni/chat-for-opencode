import { describe, expect, it, vi } from "vitest";
import manifest from "../../package.json";
import { jitteredDelay } from "../../src/shared/constants";
import { SUPPORTED_SERVER_VERSION } from "../../src/shared/compatibility";
import { OPENAPI_SNAPSHOT_VERSION } from "../../src/shared/openapi.generated";

describe("shared runtime defaults", () => {
  it("does not ship settings for a server process", () => {
    const properties = manifest.contributes.configuration.properties as Record<string, unknown>;
    for (const key of ["opencode.executablePath", "opencode.startupTimeout", "opencode.autoRestart"]) {
      expect(properties).not.toHaveProperty(key);
    }
  });

  it("lets only user or remote settings loosen permissions, never a workspace", () => {
    const properties = manifest.contributes.configuration.properties as Record<string, { scope?: string }>;
    for (const key of ["opencode.autoApprovePermissions", "opencode.sessionPermissions"]) {
      expect(properties[key].scope).toBe("machine");
    }
  });

  it("keeps the supported version in sync with the generated OpenAPI snapshot", () => {
    expect(SUPPORTED_SERVER_VERSION).toBe(OPENAPI_SNAPSHOT_VERSION);
  });

  it("jitters retry delays within +/-50% of the base delay", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(jitteredDelay(1000)).toBe(500);
      random.mockReturnValue(0.5);
      expect(jitteredDelay(1000)).toBe(1000);
      random.mockReturnValue(1);
      expect(jitteredDelay(1000)).toBe(1500);
    } finally {
      random.mockRestore();
    }
  });
});
