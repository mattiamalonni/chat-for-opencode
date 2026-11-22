import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";

import {
  diagnosticCodeActions,
  EXPLAIN_DIAGNOSTIC_COMMAND,
  FIX_DIAGNOSTIC_COMMAND,
  type CodeActionHooks,
  type DiagnosticCommandArgs,
} from "../../src/chat/codeActions";

type Action = { title: string; command: string; args: DiagnosticCommandArgs; preferred: boolean };

function setup(scheme = "file") {
  const hooks: CodeActionHooks<Action> = {
    t: (message) => message,
    create: (title, command, args, preferred) => ({ title, command, args, preferred }),
  };
  const document = { uri: { scheme, toString: () => "file:///src/app.ts" } } as vscode.TextDocument;
  return { hooks, document };
}

function diagnostic(line: number, message: string, severity = 0): vscode.Diagnostic {
  return {
    range: { start: { line, character: 2 }, end: { line, character: 9 } },
    message,
    severity,
  } as vscode.Diagnostic;
}

const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 12 } } as vscode.Range;

describe("diagnosticCodeActions", () => {
  it("offers a fix and an explanation for each diagnostic touching the range", () => {
    const { document, hooks } = setup();
    const actions = diagnosticCodeActions(document, range, [diagnostic(3, "Cannot find name 'foo'.")], hooks);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      title: "Fix with OpenCode: Cannot find name 'foo'.",
      command: FIX_DIAGNOSTIC_COMMAND,
      preferred: true,
    });
    expect(actions[1]).toMatchObject({
      title: "Explain with OpenCode: Cannot find name 'foo'.",
      command: EXPLAIN_DIAGNOSTIC_COMMAND,
      preferred: false,
    });
    expect(actions[0].args).toEqual({
      uri: "file:///src/app.ts",
      startLine: 4,
      endLine: 4,
      message: "Cannot find name 'foo'.",
      severity: 0,
    });
  });

  it("ignores diagnostics outside the requested range and deduplicates by position and message", () => {
    const { document, hooks } = setup();
    const actions = diagnosticCodeActions(
      document,
      range,
      [
        diagnostic(0, "far away"),
        diagnostic(3, "here"),
        { ...diagnostic(3, "here"), range: { start: { line: 3, character: 7 }, end: { line: 3, character: 9 } } } as vscode.Diagnostic,
      ],
      hooks,
    );
    expect(actions).toHaveLength(2);
    expect(actions[0].args.message).toBe("here");
  });

  it("skips non-file documents and an empty diagnostic list", () => {
    const { hooks } = setup("untitled");
    expect(diagnosticCodeActions({ uri: { scheme: "untitled" } } as vscode.TextDocument, range, [diagnostic(3, "x")], hooks)).toEqual([]);
    expect(diagnosticCodeActions(setup().document, range, [], hooks)).toEqual([]);
  });

  it("caps the number of diagnostics and truncates long titles and messages", () => {
    const { document, hooks } = setup();
    const diagnostics = Array.from({ length: 6 }, (_, i) => diagnostic(3, `Problem ${i}`));
    const capped = diagnosticCodeActions(document, range, diagnostics, hooks);
    // Three diagnostics, two actions each; the other three never reach the lightbulb.
    expect(capped).toHaveLength(6);
    expect(capped.map((a) => a.args.message)).toEqual(["Problem 0", "Problem 0", "Problem 1", "Problem 1", "Problem 2", "Problem 2"]);

    const long = diagnostic(3, `${"x".repeat(400)}\nsecond line`);
    const [action] = diagnosticCodeActions(document, range, [long], hooks);
    expect(action.args.message).toHaveLength(300);
    expect(action.title.endsWith("…")).toBe(true);
    expect(action.title).not.toContain("\n");
  });

  it("passes the translated label through to the action factory", () => {
    const { document } = setup();
    const t = vi.fn((message: string) => `<${message}>`);
    const actions = diagnosticCodeActions(document, range, [diagnostic(3, "boom")], { t, create: setup().hooks.create });
    expect(t).toHaveBeenCalledWith("Fix with OpenCode");
    expect(t).toHaveBeenCalledWith("Explain with OpenCode");
    expect(actions[0].title).toBe("<Fix with OpenCode>: boom");
  });
});
