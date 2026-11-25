import { describe, expect, it } from "vitest";

import type { CredentialSummary } from "../../src/shared/api";
import { statusTooltip, type StatusTooltipData } from "../../src/status/tooltip";

const anthropic: CredentialSummary = { id: "c1", integrationID: "anthropic", label: "Anthropic", active: true, type: "oauth" };
const openai: CredentialSummary = { id: "c2", integrationID: "openai", label: "OpenAI", active: false, type: "key" };
const t = (message: string, ...args: (string | number)[]): string =>
  `<${args.reduce<string>((text, arg, i) => text.replace(`{${i}}`, String(arg)), message)}>`;
const base = (overrides: Partial<StatusTooltipData> = {}): StatusTooltipData => ({
  trusted: true,
  loadFailed: false,
  credentials: [anthropic],
  ...overrides,
});

describe("statusTooltip", () => {
  it("shows only the account names as compact themed rows", () => {
    const tip = statusTooltip(base({ credentials: [anthropic, openai] }), t);
    expect(tip).toContain('**<span style="color:var(--vscode-foreground);">$(account) <OpenCode></span>**');
    expect(tip).toContain(
      '<span style="background-color:var(--vscode-list-activeSelectionBackground);display:inline-block;border-radius:4px;">&nbsp;$(verified)&nbsp;<strong>Anthropic</strong>',
    );
    expect(tip).toContain(
      '<span style="background-color:var(--vscode-list-hoverBackground);display:inline-block;border-radius:4px;">&nbsp;$(account)&nbsp;OpenAI',
    );
    // A single paragraph break between rows, no empty spacer paragraph.
    expect(tip).not.toContain("\n&nbsp;\n");
    expect(tip).not.toContain("oauth");
    expect(tip).not.toContain("key ·");
    expect(tip).not.toContain("active ·");
    expect(tip).not.toContain("Connected");
  });

  it("shows a single hint when there is no account, an error, or the workspace is untrusted", () => {
    expect(statusTooltip(base({ credentials: [] }), t)).toContain("> $(info) <No connected account>");
    expect(statusTooltip(base({ credentials: undefined }), t)).toContain("> $(info) <No connected account>");
    expect(statusTooltip(base({ loadFailed: true }), t)).toContain("> $(alert) <Could not load OpenCode login information>");
    expect(statusTooltip(base({ trusted: false }), t)).toContain("> $(shield) <Trust this workspace to use OpenCode>");
  });

  it("escapes provider labels that contain markdown characters", () => {
    expect(statusTooltip(base({ credentials: [{ ...anthropic, label: "Acme | alpha" }] }), t)).toContain("Acme \\| alpha");
  });
});
