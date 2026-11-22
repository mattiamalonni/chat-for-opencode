import * as vscode from "vscode";
import { appendOutput, type TerminalLike } from "./contextSources";

export class TerminalOutputTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly running = new Map<vscode.Terminal, { command: string; output: string }>();
  private last: TerminalLike | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const command = event.execution.commandLine.value;
        const entry = { command, output: "" };
        this.running.set(event.terminal, entry);
        // `read()` may only be called once and must be called before the stream ends.
        void (async () => {
          try {
            for await (const chunk of event.execution.read()) {
              const current = this.running.get(event.terminal);
              if (current === entry) current.output = appendOutput(current.output, chunk);
            }
          } catch {
            // A cancelled command has no usable output; keep whatever arrived before the error.
          }
        })();
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const entry = this.running.get(event.terminal);
        if (!entry) return;
        this.running.delete(event.terminal);
        if (entry.output.trim()) this.last = { command: entry.command, text: entry.output };
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.running.delete(terminal)),
    );
  }

  latest(): TerminalLike | undefined {
    return this.last;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
