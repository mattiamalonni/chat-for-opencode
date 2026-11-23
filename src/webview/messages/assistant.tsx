import { type ChatState, type TextPart, type UiAssistantMessage } from "../../shared/chatReducer";

import { useT } from "../i18n";
import { IconChevron, IconCopy, IconError, IconFileMarkdown, IconWarning } from "../icons";

import { post } from "../vscode";

export function AssistantView({
  message,
  state,
  grouped,
  showStatus = true,
  searchQuery = "",
  filteredOut = false,
}: {
  message: UiAssistantMessage;
  state: ChatState;
  grouped: boolean;
  showStatus?: boolean;
  searchQuery?: string;
  filteredOut?: boolean;
}) {
  const t = useT();
  return (
    <article
      class={`msg assistant${grouped ? " grouped" : ""}${filteredOut ? " filtered-out" : ""}`}
      aria-label={t("assistant")}
      aria-busy={!message.done}
      data-message-id={message.id}
    >
      {message.parts.map((p) =>
        p.kind === "tool" ? (
          <ToolCard key={p.key} part={p} state={state} searchQuery={searchQuery} />
        ) : p.kind === "reasoning" ? (
          <Reasoning key={p.key} part={p} />
        ) : (
          <SearchableMarkdown key={p.key} text={p.text} query={searchQuery} />
        ),
      )}
      {showStatus && <AssistantStatus message={message} typing={message.parts.length === 0} />}
      <div class="turn-actions assistant-actions">
        <button
          type="button"
          class="icon-button copy-response tooltip-host"
          data-tooltip={t("copyResponse")}
          aria-label={t("copyResponse")}
          disabled={!message.done || message.parts.length === 0}
          onClick={() => post({ type: "copy", text: visibleResponseText(message) })}
        >
          <IconCopy />
        </button>
        <button
          type="button"
          class="icon-button save-instruction tooltip-host"
          data-tooltip={t("saveInstruction")}
          aria-label={t("saveInstruction")}
          disabled={!message.done || message.parts.length === 0}
          onClick={() => post({ type: "saveInstruction", text: visibleResponseText(message) })}
        >
          <IconFileMarkdown />
        </button>
      </div>
    </article>
  );
}

/** Retry/error feedback and the waiting indicator, shared by whole and split assistant messages. */
export function AssistantStatus({
  message,
  typing,
  filteredOut = false,
}: {
  message: UiAssistantMessage;
  typing?: boolean;
  filteredOut?: boolean;
}) {
  const t = useT();
  const hidden = filteredOut ? " filtered-out" : "";
  return (
    <>
      {typing && !message.done && (
        <div class={`typing${hidden}`} aria-label={t("thinking")}>
          <span />
          <span />
          <span />
        </div>
      )}
      {message.retry && (
        <div class={`notice warning${hidden}`} role="status">
          <IconWarning />
          {t("retrying", message.retry.attempt, message.retry.message)}
        </div>
      )}
      {message.error && (
        <div class={`notice error${hidden}`} role="alert">
          <IconError />
          <span>{message.error.message}</span>
        </div>
      )}
    </>
  );
}

export function Reasoning({ part }: { part: TextPart }) {
  const t = useT();
  if (!part.text.trim() && part.done) return null;
  return (
    <details class="reasoning">
      <summary>
        <IconChevron class="chevron" />
        {part.done ? t("thoughts") : <span class="shimmer">{t("thinking")}…</span>}
      </summary>
      <Markdown text={part.text} />
    </details>
  );
}

import { Markdown, SearchableMarkdown, visibleResponseText } from "./text";
import { ToolCard } from "./tools";
