import { describe, expect, it } from "vitest";
import type { AssistantMessage, ServerEvent, SessionInfo, SessionMessage } from "../../src/shared/api";
import { parseBackgroundResult } from "../../src/shared/backgroundResult";
import {
  applyEvent,
  chatReducer,
  initialChatState,
  selectPendingShells,
  sessionWaitingShell,
  toSessionSummary,
} from "../../src/shared/chatReducer";

const SID = "ses_background";
const SHELL_ID = "sh_214d10d150012o6It3NILWeKMu";
// Real shape: the command attribute contains unescaped quotes, as emitted by the shell renderer.
const COMMAND = `for i in $(seq 1 15); do v=$(printf '%s' "$out" | node -e "let d='';"); echo "check $i: latest = $v"; done`;
const XML =
  `<background-result kind="shell" id="${SHELL_ID}" state="completed" command="${COMMAND}">\n` +
  `check 1: latest = 0.4.1\ncheck 8: latest = 0.4.2\n\n</background-result>`;

function shellTool(): AssistantMessage {
  return {
    id: "msg-tool",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: 1, completed: 2 },
    content: [
      {
        type: "tool",
        id: "tool-shell",
        name: "shell",
        state: {
          status: "completed",
          input: { command: COMMAND, background: true },
          content: [{ type: "text", text: "Command moved to the background" }],
          metadata: { status: "running", shellID: SHELL_ID },
        },
      },
    ],
  };
}

function backgroundMessage(): SessionMessage {
  return { id: "msg-bg", type: "synthetic", time: { created: 3 }, text: XML, description: COMMAND };
}

function open(messages: SessionMessage[] = []) {
  return chatReducer(initialChatState, { type: "load", sessionId: SID, messages, permissions: [], forms: [] });
}

describe("parseBackgroundResult", () => {
  it("reads the shell id, full command and last output line from the real XML shape", () => {
    const result = parseBackgroundResult(XML);
    expect(result?.kind).toBe("shell");
    expect(result?.id).toBe(SHELL_ID);
    expect(result?.state).toBe("completed");
    expect(result?.command).toBe(COMMAND);
    expect(result?.summary).toBe("check 8: latest = 0.4.2");
    expect(result?.output).toContain("check 1: latest = 0.4.1");
  });

  it("decodes entities and ignores other synthetic wrappers", () => {
    const escaped = parseBackgroundResult(
      `<background-result kind="shell" id="s" state="error" command="echo &quot;hi&quot;">boom</background-result>`,
    );
    expect(escaped?.command).toBe('echo "hi"');
    expect(escaped?.summary).toBe("boom");
    expect(parseBackgroundResult(`<subagent sessionID="ses_x" state="completed">report</subagent>`)).toBeUndefined();
  });
});

describe("pending background shells", () => {
  it("marks a session as waiting until the background result arrives", () => {
    expect(sessionWaitingShell([shellTool()])).toBe(true);
    expect(sessionWaitingShell([shellTool(), backgroundMessage()])).toBe(false);
    expect(toSessionSummary({ id: SID, time: { created: 1, updated: 3 } } as SessionInfo, [shellTool()]).waiting).toBe(true);
  });

  it("keeps a waiting card in the chat and settles it on the live synthetic inbox item", () => {
    const openState = open([shellTool()]);
    expect(selectPendingShells(openState).map((shell) => shell.id)).toEqual([SHELL_ID]);
    expect(selectPendingShells(openState)[0].command).toBe(COMMAND);

    const event = {
      type: "session.inbox.enqueued",
      data: { sessionID: SID, item: { type: "synthetic", payload: { text: XML, description: COMMAND } } },
    } as ServerEvent;
    const settled = applyEvent(openState, event);
    expect(settled.messages.some((m) => m.kind === "notice" && m.code === "backgroundResult")).toBe(true);
    expect(selectPendingShells(settled)).toEqual([]);
  });

  it("renders a history background result as a compact notice, not raw XML", () => {
    const loaded = open([backgroundMessage()]);
    const notice = loaded.messages.find((m) => m.kind === "notice");
    expect(notice?.code).toBe("backgroundResult");
    expect(notice?.shellId).toBe(SHELL_ID);
    expect(notice?.text).toBe("check 8: latest = 0.4.2");
    expect(JSON.stringify(loaded.messages)).not.toContain("<background-result");
  });
});
