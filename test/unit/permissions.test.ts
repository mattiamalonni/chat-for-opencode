import { describe, expect, it } from "vitest";
import manifest from "../../package.json";
import { DEFAULT_SESSION_PERMISSIONS } from "../../src/chat/permissions";

describe("default session permissions", () => {
  it("asks before edits, shell commands and access outside the workspace", () => {
    expect(DEFAULT_SESSION_PERMISSIONS).toEqual([
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ]);
  });

  it("matches the setting default shipped in package.json", () => {
    const setting = manifest.contributes.configuration.properties["opencode.sessionPermissions"];
    expect(setting.default).toEqual(DEFAULT_SESSION_PERMISSIONS);
  });

  it("ships auto-approval off by default", () => {
    const setting = manifest.contributes.configuration.properties["opencode.autoApprovePermissions"];
    expect(setting).toMatchObject({ type: "boolean", default: false });
  });
});
