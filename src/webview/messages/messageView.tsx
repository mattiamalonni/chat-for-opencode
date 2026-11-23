import { type ChatState, type UiMessage, type UiNotice } from "../../shared/chatReducer";

import type { ActionId } from "../../shared/protocol";
import { FileTypeIcon } from "../fileIcons";
import { useT } from "../i18n";
import { IconError, IconFork, IconInfo, IconRefresh, IconRevert, IconSelection, IconWarning } from "../icons";

import { post } from "../vscode";

export function MessageView({
  message,
  state,
  grouped,
  showStatus = true,
  searchQuery = "",
  filteredOut = false,
}: {
  message: UiMessage;
  state: ChatState;
  grouped: boolean;
  showStatus?: boolean;
  searchQuery?: string;
  filteredOut?: boolean;
}) {
  const t = useT();
  const hidden = filteredOut ? " filtered-out" : "";
  if (message.kind === "user") {
    const sessionId = state.sessionId;
    return (
      <article class={`msg user${hidden}`} aria-label={t("you")} data-message-id={message.id}>
        <div class="turn-actions">
          <button
            type="button"
            class="icon-button regenerate-turn tooltip-host"
            data-tooltip={state.busy ? t("regenerateTurnBusy") : t("regenerateTurn")}
            aria-label={t("regenerateTurn")}
            disabled={!sessionId || state.busy}
            onClick={() =>
              sessionId &&
              post({
                type: "regenerate",
                sessionId,
                messageID: message.id,
                text: message.text,
                attachments: message.files
                  .filter((f) => !!f.uri)
                  .map((f) => ({ uri: f.uri, name: f.name ?? fileNameOf(f.uri), kind: "file" as const })),
              })
            }
          >
            <IconRefresh />
          </button>
          <button
            type="button"
            class="icon-button fork-turn tooltip-host"
            data-tooltip={state.busy ? t("forkTurnBusy") : t("forkTurn")}
            aria-label={t("forkTurn")}
            disabled={!sessionId || state.busy}
            onClick={() => sessionId && post({ type: "forkTo", sessionId, messageID: message.id })}
          >
            <IconFork />
          </button>
          <button
            type="button"
            class="icon-button revert-turn tooltip-host"
            data-tooltip={state.busy ? t("revertTurnBusy") : t("revertTurn")}
            aria-label={t("revertTurn")}
            disabled={!sessionId || state.busy}
            onClick={() => sessionId && post({ type: "revertTo", sessionId, messageID: message.id, text: message.text })}
          >
            <IconRevert />
          </button>
        </div>
        <div class="bubble">
          <div class="user-text">
            <Highlight text={message.text} query={searchQuery} />
          </div>
          {message.files.length > 0 && (
            <ul class="chips" aria-label={t("context")}>
              {message.files.map((f) => {
                // Older/foreign payloads may lack a location; render the chip instead of crashing.
                const uri = f.uri ?? "";
                const name = f.name ?? (uri ? fileNameOf(uri) : "");
                // Only project files carry a `file:` location that the host can open; inline
                // attachments from history have no on-disk copy and stay plain text.
                const openable = uri.startsWith("file:");
                const open = () => {
                  if (openable) post({ type: "openAttachment", uri });
                };
                return (
                  <li class="chip readonly" key={uri || name} title={uri || name}>
                    <span
                      class="chip-open"
                      data-openable={openable ? "true" : "false"}
                      role={openable ? "button" : undefined}
                      tabIndex={openable ? 0 : undefined}
                      aria-label={openable ? `${t("openFile")}: ${name}` : undefined}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (openable && e.key === "Enter") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      {uri.includes("?start=") ? <IconSelection /> : <FileTypeIcon path={name || uri} />}
                      <span>{name}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </article>
    );
  }
  if (message.kind === "notice") return <NoticeView notice={message} filteredOut={filteredOut} />;
  return (
    <AssistantView
      message={message}
      state={state}
      grouped={grouped}
      showStatus={showStatus}
      searchQuery={searchQuery}
      filteredOut={filteredOut}
    />
  );
}

export function NoticeView({ notice, filteredOut = false }: { notice: UiNotice; filteredOut?: boolean }) {
  const t = useT();
  let text = notice.text;
  if (notice.code === "interrupted") text = t("interrupted");
  else if (notice.code === "failed") text = `${t("failedResponse")}${notice.text ? `: ${notice.text}` : "."}`;
  else if (notice.code === "agent") text = t("agentSwitched", notice.text);
  else if (notice.code === "model") text = t("modelSwitched", notice.text);
  else if (notice.code === "compaction") text = t("compacted");
  const Icon = notice.level === "error" ? IconError : notice.level === "warning" ? IconWarning : IconInfo;
  const providerHint = notice.code === "failed" && /api key|auth|credential|provider|unauthori|401/i.test(notice.text);
  return (
    <div class={`notice ${notice.level}${filteredOut ? " filtered-out" : ""}`} role={notice.level === "error" ? "alert" : "status"}>
      <Icon />
      <span>{text}</span>
      {notice.code === "failed" && (
        <span class="notice-actions">
          {providerHint && <ActionButton id="login" />}
          <ActionButton id="showLogs" />
        </span>
      )}
    </div>
  );
}

export function ActionButton({ id }: { id: ActionId }) {
  const t = useT();
  return (
    <button type="button" class="link-button" onClick={() => post({ type: "action", id })}>
      {t(`action.${id}`)}
    </button>
  );
}

import { AssistantView } from "./assistant";

import { fileNameOf, Highlight } from "./text";
