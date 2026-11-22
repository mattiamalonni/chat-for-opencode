import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { FormField, FormRequest, FormValue, ModelInfo, PermissionRequest } from "../shared/api";
import {
  formsForTool,
  permissionsForTool,
  selectToolFiles,
  type ChatState,
  type TurnStats,
  type ChangedFile,
  type TextPart,
  type ToolPart,
  type UiAssistantMessage,
  type UiMessage,
  type UiNotice,
} from "../shared/chatReducer";
import { fileRefToOpenPath, isFileRef } from "../shared/fileRef";
import { formatTokens } from "../shared/format";
import { isImeKey } from "../shared/keys";
import type { ActionId } from "../shared/protocol";
import { isSubagentTool, subagentChildId, subagentView, toolInputSummary, type SubagentActivity } from "../shared/subagents";
import { env, isolateKeys } from "./env";
import { FileTypeIcon } from "./fileIcons";
import { useT } from "./i18n";
import {
  IconCheck,
  IconChevron,
  IconCopy,
  IconError,
  IconFileMarkdown,
  IconFork,
  IconInfo,
  IconOpen,
  IconRefresh,
  IconRevert,
  IconSelection,
  IconTool,
  IconWarning,
} from "./icons";
import { renderMarkdown } from "./markdown";
import { clearReplyFailure, useReplyFailed } from "./replyFeedback";
import { useOpenSubagent, useSubagent } from "./subagents";
import { post } from "./vscode";

/** URI decoding can throw on malformed escapes; never let that take down the whole chat. */
function fileNameOf(uri: string): string {
  const raw = uri.split("/").pop() ?? uri;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Splits a path into its file name and parent directory (with trailing separator). Accepts both POSIX and Windows separators. */
function splitFilePath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Plain-text representation used for header search and Markdown export. Messages are immutable
 * (the reducer allocates a new object only for the one that changed), so cache by identity: the
 * search count and the export no longer rebuild strings for every unchanged message each frame.
 */
const searchTextCache = new WeakMap<UiMessage, string>();
export function messageSearchText(message: UiMessage): string {
  const cached = searchTextCache.get(message);
  if (cached !== undefined) return cached;
  let text: string;
  if (message.kind === "assistant") {
    const parts = message.parts.map((p) =>
      p.kind === "tool"
        ? [p.name, p.inputText, ...p.output.map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`))].join(" ")
        : p.text,
    );
    text = [...parts, message.error?.message ?? "", message.retry?.message ?? ""].join(" ");
  } else {
    text = message.text;
  }
  searchTextCache.set(message, text);
  return text;
}

/**
 * Only the text the reader actually sees. `messageSearchText` also folds tool I/O and reasoning
 * into one string for search/export, which is wrong for the "Copy this response" action.
 */
export function visibleResponseText(message: UiAssistantMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Highlights a query in plain text. Markdown bodies keep their rendered HTML and are not rewritten. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const children: (string | ComponentChildren)[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  let i = 0;
  while (at !== -1) {
    if (at > from) children.push(text.slice(from, at));
    children.push(
      <mark key={`m${i++}`} data-search-match="true">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) children.push(text.slice(from));
  return <>{children}</>;
}

/**
 * Search marks the text *inside* the rendered Markdown, so bold/code/links keep their formatting.
 * `renderMarkdown` sanitises first and marks text nodes afterwards; no untrusted HTML is reparsed.
 */
function SearchableMarkdown({ text, query }: { text: string; query: string }) {
  const html = useMemo(() => renderMarkdown(text, query), [text, query]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

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

function NoticeView({ notice, filteredOut = false }: { notice: UiNotice; filteredOut?: boolean }) {
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

let clockFormatter: Intl.DateTimeFormat | undefined;
let clockFormatterLang: string | undefined;
/** HH:mm in the webview locale; the host passes VS Code's language as `document.documentElement.lang`. */
function formatClock(ts: number): string {
  const lang = document.documentElement.lang || undefined;
  if (!clockFormatter || clockFormatterLang !== lang) {
    clockFormatter = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clockFormatterLang = lang;
  }
  return clockFormatter.format(new Date(ts));
}

/** Wall-clock time and total usage for a whole user turn, from input to the last step. */
export function TurnStatsRow({ stats, models }: { stats: TurnStats; models: ModelInfo[] }) {
  if (stats.ended === undefined) return null;
  return <StatsRow stats={stats} ended={stats.ended} models={models} />;
}

/** Has to be a component: `useT` is a hook. The guard above keeps unfinished turns invisible. */
function StatsRow({ stats, ended, models }: { stats: TurnStats; ended: number; models: ModelInfo[] }) {
  const t = useT();
  const total =
    stats.tokens && stats.tokens.input + stats.tokens.output + stats.tokens.reasoning + stats.tokens.cache.read + stats.tokens.cache.write;
  const elapsed = Math.max(0, ended - stats.started);

  let duration: string;
  const seconds = Math.round(elapsed / 100) / 10;
  if (seconds < 60) duration = t("turnDuration", seconds.toFixed(1));
  else {
    let minutes = Math.floor(seconds / 60);
    let rest = Math.round(seconds - minutes * 60);
    if (rest === 60) {
      minutes += 1;
      rest = 0;
    }
    duration = t("turnDurationMinutes", minutes, rest);
  }
  const startedAt = formatClock(stats.started);
  const endedAt = formatClock(ended);
  const usedModel = stats.model;
  const modelName =
    usedModel && usedModel.id && usedModel.providerID
      ? (models.find((m) => m.id === usedModel.id && m.providerID === usedModel.providerID)?.name ??
        `${usedModel.providerID}/${usedModel.id}`)
      : undefined;
  const steps = stats.steps && stats.steps > 0 ? t("stepCount", stats.steps) : undefined;
  const tokens = total && total > 0 ? t("tokens", formatTokens(total)) : undefined;
  const cost = stats.cost !== undefined && stats.cost > 0 ? `$${stats.cost.toFixed(stats.cost < 0.01 ? 4 : 2)}` : undefined;
  const shown = [steps, duration, tokens, cost].filter((x): x is string => x !== undefined);
  const additions = stats.additions ?? 0;
  const deletions = stats.deletions ?? 0;
  const hasChanges = additions > 0 || deletions > 0;
  const openable = (stats.files ?? []).filter((f) => f.patch);
  // No visual tooltip on this bar; the label is only for screen readers.
  const summaryLabel = [
    t("turnStatsStarted", startedAt),
    t("turnStatsEnded", endedAt),
    modelName ? t("turnStatsModel", modelName) : undefined,
    t("turnStatsTooltip", duration, tokens ?? t("turnStatsUnknown"), cost ?? t("turnStatsUnknown"), steps ?? t("turnStatsUnknown")),
    hasChanges ? t("turnStatsChanges", additions, deletions) : undefined,
    openable.length > 0 ? t("turnStatsOpenDiff") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const counts = (
    <>
      {additions > 0 && <span class="adds">+{additions}</span>}
      {additions > 0 && deletions > 0 ? " " : ""}
      {deletions > 0 && <span class="dels">-{deletions}</span>}
    </>
  );
  return (
    <div class="turn-stats" role="group" aria-label={summaryLabel}>
      <span class="turn-stats-time" aria-hidden="true">
        {startedAt}
      </span>
      <span class="turn-stats-line" aria-hidden="true" />
      <span class="turn-stats-text">
        {modelName !== undefined && (
          <>
            <span class="turn-stats-model" title={modelName}>
              {modelName}
            </span>
            {shown.length > 0 ? " · " : ""}
          </>
        )}
        {shown.join(" · ")}
        {hasChanges && (
          <>
            {shown.length > 0 || modelName !== undefined ? " · " : ""}
            {openable.length > 0 ? (
              <button
                type="button"
                class="change-counts"
                aria-label={t("openDiff")}
                onClick={() => post({ type: "openDiffs", files: openable.map((f) => ({ file: f.file, patch: f.patch })) })}
              >
                {counts}
              </button>
            ) : (
              counts
            )}
          </>
        )}
      </span>
      <span class="turn-stats-line" aria-hidden="true" />
      <span class="turn-stats-time" aria-hidden="true">
        {endedAt}
      </span>
    </div>
  );
}

function AssistantView({
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

function Reasoning({ part }: { part: TextPart }) {
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

export function toolSummary(part: ToolPart): string {
  return toolInputSummary(part);
}

/** The file a tool was called on, when the input carries one. */
function toolFilePath(part: ToolPart): string | undefined {
  const input = part.input;
  if (!input) return undefined;
  for (const key of ["filePath", "path", "file"]) {
    const value = input[key];
    if (typeof value === "string" && isFileRef(value)) return fileRefToOpenPath(value);
  }
  return undefined;
}

/** Ticks once a second only while a subagent is running, for the elapsed-time label. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

type T = ReturnType<typeof useT>;

function activityText(activity: SubagentActivity, t: T): string {
  switch (activity.kind) {
    case "thinking":
      return `${t("thinking")}…`;
    case "tool":
      return activity.tool.summary ? `${activity.tool.name}: ${activity.tool.summary}` : activity.tool.name;
    case "text":
      return activity.text.split("\n")[0].slice(0, 100);
    case "done":
      return t("completed");
    case "idle":
      return t("pending");
  }
}

function subagentDot(status: string): "running" | "error" | "completed" {
  return status === "error" ? "error" : status === "completed" || status === "cancelled" ? "completed" : "running";
}

export function ToolGroup({
  parts,
  state,
  filteredOut = false,
  searchQuery = "",
}: {
  parts: ToolPart[];
  state: ChatState;
  filteredOut?: boolean;
  searchQuery?: string;
}) {
  const t = useT();
  const openSubagent = useOpenSubagent();
  const needsUser = parts.some((p) => permissionsForTool(state, p.id).length > 0 || formsForTool(state, p.id).length > 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (needsUser) setOpen(true);
  }, [needsUser]);
  const subagentPart = parts.find(isSubagentTool);
  const subEntry = useSubagent(subagentPart ? subagentChildId(subagentPart) : undefined);
  const sub = subagentPart ? subagentView(subagentPart, subEntry?.state, subEntry?.meta, state.subagentReports) : undefined;
  const subSessionId = sub?.sessionId;
  const subWaiting = !!sub?.needsInput;
  // Search must be able to reach text inside a collapsed card.
  const expanded = open || needsUser || subWaiting || !!searchQuery;
  const running = parts.some((p) => p.status === "running" || p.status === "streaming");
  const failed = parts.some((p) => p.status === "error");
  const status = sub ? (subWaiting ? "waiting" : subagentDot(sub.status)) : running ? "running" : failed ? "error" : "completed";
  const statusLabel = sub
    ? subWaiting
      ? t("needsInput")
      : sub.status === "error"
        ? t("failed")
        : sub.status === "cancelled"
          ? t("cancelled")
          : sub.status === "completed"
            ? t("completed")
            : t("running")
    : running
      ? t("running")
      : failed
        ? t("failed")
        : t("completed");
  const names = [...new Set(parts.map((p) => p.name))].join(", ");
  const headerName = sub ? sub.agent : t("toolCalls", parts.length);
  const headerSummary = sub
    ? [sub.title, subWaiting ? t("subagentWaitingForInput") : activityText(sub.activity, t)].filter(Boolean).join(" · ")
    : names;
  const id = `tool-group-${parts[0].id}`;
  return (
    <section
      class={`tool-group${sub ? " subagent" : ""}${needsUser || subWaiting ? " attention" : ""}${filteredOut ? " filtered-out" : ""}`}
    >
      <div class="tool-header-row">
        <button
          type="button"
          class="tool-header tool-group-header"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <IconChevron class="chevron" />
          <span class={`status-dot ${status} tooltip-host`} role="img" aria-label={statusLabel} data-tooltip={statusLabel}>
            {subWaiting ? <IconWarning /> : status === "completed" ? <IconCheck /> : status === "error" ? <IconError /> : <IconTool />}
          </span>
          {sub && <span class="subagent-badge">{t("subagent")}</span>}
          {subWaiting && <span class="subagent-waiting">{t("needsInput")}</span>}
          <span class="tool-name">{headerName}</span>
          <span class="tool-summary" title={headerSummary}>
            <Highlight text={headerSummary} query={searchQuery} />
          </span>
        </button>
        {subSessionId && (
          <button
            type="button"
            class="icon-button tool-open tooltip-host"
            data-tooltip={t("openSubagent")}
            aria-label={t("openSubagent")}
            onClick={() => openSubagent(subSessionId, sub.agent || sub.title)}
          >
            <IconOpen />
          </button>
        )}
      </div>
      {expanded && (
        <div class="tool-group-body" id={id}>
          {parts.map((p) => (
            <ToolCard key={p.key} part={p} state={state} searchQuery={searchQuery} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Dispatch on the tool name so hook order stays stable for each card. */
export function ToolCard(props: { part: ToolPart; state: ChatState; filteredOut?: boolean; searchQuery?: string }) {
  return isSubagentTool(props.part) ? <SubagentToolCard {...props} /> : <GenericToolCard {...props} />;
}

/** The tool result wraps the child report in a `<subagent>` tag; the child's own text is plain. */
function stripSubagentWrapper(text: string): string {
  return text.replace(/^\s*<subagent\b[^>]*>\s*/i, "").replace(/\s*<\/subagent>\s*$/i, "");
}

/** A subagent call stays one line until expanded; its child's progress is shown on demand. */
function SubagentToolCard({
  part,
  state,
  filteredOut = false,
  searchQuery = "",
}: {
  part: ToolPart;
  state: ChatState;
  filteredOut?: boolean;
  searchQuery?: string;
}) {
  const t = useT();
  const openSubagent = useOpenSubagent();
  const sessionId = subagentChildId(part);
  const entry = useSubagent(sessionId);
  const view = useMemo(() => subagentView(part, entry?.state, entry?.meta, state.subagentReports), [part, entry, state.subagentReports]);
  const [open, setOpen] = useState(false);
  const running = view.status === "running" || view.status === "pending";
  const now = useNow(running);
  // A child blocked on a permission/question must not keep showing the generic "running" spinner:
  // that is exactly the "si è fermato" impression. Mark it as waiting for the user instead.
  const waiting = view.needsInput;
  const dot = waiting ? "waiting" : subagentDot(view.status);
  const elapsed = view.started === undefined ? undefined : `${Math.max(0, Math.round(((view.ended ?? now) - view.started) / 1000))}s`;
  const statusLabel = waiting
    ? t("needsInput")
    : view.status === "error"
      ? t("failed")
      : view.status === "cancelled"
        ? t("cancelled")
        : view.status === "completed"
          ? t("completed")
          : t("running");
  const activity = waiting ? t("subagentWaitingForInput") : activityText(view.activity, t);
  const header = [view.agent || t("subagent"), view.title, activity, elapsed].filter(Boolean).join(" · ");
  const id = `subagent-${part.id}`;
  return (
    <section
      class={`tool subagent ${dot}${waiting ? " attention" : ""}${filteredOut ? " filtered-out" : ""}`}
      aria-label={`${t("subagent")}: ${header}`}
    >
      <div class="tool-header-row">
        <button
          type="button"
          class="tool-header"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            const next = !open;
            setOpen(next);
            // A background child can finish long after its tool call; if no live state arrived,
            // ask the host for its history so the report and steps are shown on demand.
            if (next && sessionId && (!entry || entry.state.messages.length === 0)) post({ type: "refreshSubagent", sessionId });
          }}
        >
          <IconChevron class="chevron" />
          <span class={`status-dot ${dot} tooltip-host`} role="img" aria-label={statusLabel} data-tooltip={statusLabel}>
            {waiting ? <IconWarning /> : dot === "completed" ? <IconCheck /> : dot === "error" ? <IconError /> : <IconTool />}
          </span>
          <span class="subagent-badge">{t("subagent")}</span>
          {waiting && <span class="subagent-waiting">{t("needsInput")}</span>}
          <span class="tool-summary" title={header}>
            {header}
          </span>
        </button>
        {sessionId && (
          <button
            type="button"
            class="icon-button tool-open tooltip-host"
            data-tooltip={t("openSubagent")}
            aria-label={t("openSubagent")}
            onClick={() => openSubagent(sessionId, view.agent || view.title)}
          >
            <IconOpen />
          </button>
        )}
      </div>
      {open && (
        <div class="tool-body subagent-body" id={id}>
          <div class="subagent-activity">
            <span class="tool-label">{t("activity")}</span>
            <span>
              {activity}
              {elapsed ? ` · ${elapsed}` : ""}
            </span>
          </div>
          {view.task && (
            <details class="tool-section">
              <summary class="tool-label">{t("task")}</summary>
              <pre class="tool-pre">
                <Highlight text={view.task} query={searchQuery} />
              </pre>
            </details>
          )}
          {view.tools.length > 0 && (
            <div class="tool-section">
              <div class="tool-label">
                {t("steps")} ({view.tools.length})
              </div>
              <ul class="subagent-steps">
                {view.tools.map((tool, i) => {
                  const label = tool.status === "error" ? t("failed") : tool.status === "completed" ? t("completed") : t("running");
                  return (
                    <li class={`subagent-step ${tool.status}`} key={`${tool.name}-${i}`}>
                      <span
                        class={`status-dot ${subagentDot(tool.status)} tooltip-host`}
                        role="img"
                        aria-label={label}
                        data-tooltip={label}
                      >
                        {tool.status === "error" ? <IconError /> : tool.status === "completed" ? <IconCheck /> : <IconTool />}
                      </span>
                      <span class="step-name">{tool.name}</span>
                      {tool.summary && (
                        <span class="step-summary" title={tool.summary}>
                          {tool.summary}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {view.report && (
            <div class="tool-section">
              <div class="tool-label">{t("report")}</div>
              <TruncatedPre text={stripSubagentWrapper(view.report)} query={searchQuery} />
            </div>
          )}
          <details class="tool-section">
            <summary class="tool-label">{t("input")}</summary>
            <pre class="tool-pre">
              <Highlight text={part.inputText} query={searchQuery} />
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}

function GenericToolCard({
  part,
  state,
  filteredOut = false,
  searchQuery = "",
}: {
  part: ToolPart;
  state: ChatState;
  filteredOut?: boolean;
  searchQuery?: string;
}) {
  const t = useT();
  const permissions = permissionsForTool(state, part.id);
  const forms = formsForTool(state, part.id);
  const needsUser = permissions.length > 0 || forms.length > 0;
  const [open, setOpen] = useState(false);
  const files = useMemo(() => selectToolFiles(part), [part.metadata]);
  const expanded = open || needsUser || !!searchQuery;
  // When a question is pending, the FormCard already renders the same
  // information in a friendly way — showing the raw JSON input too is noise.
  const showInput = part.inputText && forms.length === 0;
  const summary = toolSummary(part);
  const inputFile = toolFilePath(part);
  const statusLabel =
    part.status === "completed" ? t("completed") : part.status === "error" ? t("failed") : needsUser ? t("pending") : t("running");
  // A completed tool's output can be large, and the card is usually collapsed. Only rebuild the
  // string when this part's output actually changes (the reducer keeps part identity stable).
  const output = useMemo(
    () => part.output.map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`)).join("\n"),
    [part.output],
  );
  const id = `tool-${part.id}`;
  return (
    <section
      class={`tool ${part.status}${needsUser ? " attention" : ""}${filteredOut ? " filtered-out" : ""}`}
      aria-label={`${t("tool")}: ${part.name}`}
    >
      <button type="button" class="tool-header" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
        <IconChevron class="chevron" />
        <span class={`status-dot ${part.status} tooltip-host`} role="img" aria-label={statusLabel} data-tooltip={statusLabel}>
          {part.status === "completed" ? <IconCheck /> : part.status === "error" ? <IconError /> : <IconTool />}
        </span>
        <span class="tool-name">{part.name}</span>
        <span class="tool-summary" title={summary}>
          <Highlight text={summary} query={searchQuery} />
        </span>
      </button>
      {expanded && (
        <div class="tool-body" id={id}>
          {showInput && (
            <div class="tool-section">
              <div class="tool-label">{t("input")}</div>
              <pre class="tool-pre">
                <Highlight text={part.inputText} query={searchQuery} />
              </pre>
            </div>
          )}
          {output && (
            <div class="tool-section">
              <div class="tool-label">{t("output")}</div>
              <TruncatedPre text={output} query={searchQuery} />
            </div>
          )}
          {part.error && part.error.message && (
            <div class="tool-section">
              <div class="tool-label">{t("error")}</div>
              <pre class="tool-pre error-text">
                <Highlight text={part.error.message} query={searchQuery} />
              </pre>
            </div>
          )}
          {inputFile && (
            <button
              type="button"
              class="link-button tool-open-file"
              title={`${t("openFile")}: ${inputFile}`}
              onClick={() => post({ type: "openFile", path: inputFile })}
            >
              {t("openFile")}: {inputFile}
            </button>
          )}
        </div>
      )}
      {files.length > 0 && <FileList files={files} applied={part.status === "completed"} />}
      {/* Requests are rendered once in the attention overlay above the composer. The tool keeps
          its "attention" marker so it is easy to spot which call is waiting, but the actionable
          card must not be duplicated here (or hidden inside a folded step). */}
    </section>
  );
}

function TruncatedPre({ text, query = "" }: { text: string; query?: string }) {
  const [full, setFull] = useState(false);
  const limit = env.toolOutputLimit;
  const t = useT();
  if (text.length <= limit || full)
    return (
      <pre class="tool-pre">
        <Highlight text={text} query={query} />
      </pre>
    );
  return (
    <div>
      <pre class="tool-pre">
        <Highlight text={text.slice(0, limit)} query={query} />…
      </pre>
      <button type="button" class="link-button" onClick={() => setFull(true)}>
        {t("output")} ({text.length.toLocaleString("en")})
      </button>
    </div>
  );
}

export function FileList({ files, applied }: { files: ChangedFile[]; applied: boolean }) {
  const t = useT();
  return (
    <ul class="file-list">
      {files.map((f) => {
        const { name, dir } = splitFilePath(f.file);
        const label = (
          <span class="file-name">
            <span class="file-base">{name}</span>
            {dir && <span class="file-path">{dir}</span>}
          </span>
        );
        return (
          <li key={f.file} class="file-item">
            {f.patch ? (
              <button
                type="button"
                class="file-row"
                title={`${t("openDiff")}: ${f.file}`}
                onClick={() => post({ type: "openDiff", file: f.file, patch: f.patch, applied })}
              >
                <FileTypeIcon path={f.file} />
                {label}
                <span class="adds">+{f.additions}</span>
                <span class="dels">-{f.deletions}</span>
              </button>
            ) : (
              <span class="file-row" title={t("noDiffAvailable")}>
                <FileTypeIcon path={f.file} />
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const failed = useReplyFailed("permission", request.id);
  // A resync re-posts the same pending request as a fresh object: re-enable its buttons.
  useEffect(() => setBusy(false), [request]);
  const files = request.metadata?.files ?? [];
  const reply = (decision: "once" | "always" | "reject") => {
    clearReplyFailure({ kind: "permission", id: request.id });
    setBusy(true);
    post({ type: "permissionReply", sessionId: request.sessionID, requestId: request.id, decision });
  };
  const disabled = busy && !failed;
  const labelId = `perm-${request.id}`;
  const hasAlways = (request.save?.length ?? 0) > 0;
  // Focusing the card (Tab) turns 1/2/3 into Allow once / Always / Reject. Ignore IME and chords so
  // typing in the workbench or composing text never triggers a permission decision by accident.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || isImeKey(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || disabled || e.repeat) return;
    // A focused button or link inside the card must keep its own key handling (and long-press of
    // the shortcut must not fire several permission replies before the state update lands).
    if ((e.target as HTMLElement)?.closest("button, input, a, textarea, select")) return;
    let decision: "once" | "always" | "reject" | undefined;
    if (e.key === "1") decision = "once";
    else if (e.key === "2" && hasAlways) decision = "always";
    else if (e.key === "3") decision = "reject";
    if (!decision) return;
    e.preventDefault();
    e.stopPropagation();
    reply(decision);
  };
  return (
    <div class="card permission" role="group" aria-labelledby={labelId} tabIndex={0} onKeyDown={onKeyDown}>
      <div class="card-title" id={labelId}>
        <IconWarning /> {t("permissionTitle")}: <code>{request.action}</code>
      </div>
      {request.message && <p class="card-text">{request.message}</p>}
      {request.resources.length > 0 && (
        <ul class="resources" aria-label={t("permissionResources")}>
          {request.resources.map((r) => (
            <li key={r}>
              {isFileRef(r) ? (
                <button
                  type="button"
                  class="link-button resource-link"
                  title={`${t("openFile")}: ${r}`}
                  aria-label={`${t("openFile")}: ${r}`}
                  onClick={() => post({ type: "openFile", path: fileRefToOpenPath(r) })}
                >
                  {r}
                </button>
              ) : (
                <code>{r}</code>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && <FileList files={files} applied={false} />}
      <div class="card-actions">
        <button type="button" class="primary" disabled={disabled} onClick={() => reply("once")}>
          {t("permissionAllowOnce")}
        </button>
        {hasAlways && (
          <button type="button" class="secondary" disabled={disabled} onClick={() => reply("always")}>
            {t("permissionAllowAlways")}
          </button>
        )}
        <button type="button" class="secondary danger" disabled={disabled} onClick={() => reply("reject")}>
          {t("permissionReject")}
        </button>
        <span class="shortcut-hint" aria-hidden="true">
          {hasAlways ? t("permissionShortcutHint") : t("permissionShortcutHintNoAlways")}
        </span>
      </div>
    </div>
  );
}

export function initialValue(f: FormField): FormValue | undefined {
  const d = f.default;
  if (d !== undefined) {
    // A malformed default (null, object, array for a string field) must not leak into the input as
    // "[object Object]" or be submitted verbatim.
    switch (f.type) {
      case "boolean":
        return typeof d === "boolean" ? d : false;
      case "multiselect":
        return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
      case "number":
      case "integer":
        return typeof d === "number" && Number.isFinite(d) ? d : undefined;
      case "external":
        return undefined;
      default:
        return typeof d === "string" || (typeof d === "number" && Number.isFinite(d)) ? (d as FormValue) : undefined;
    }
  }
  if (f.type === "boolean") return false;
  if (f.type === "multiselect") return [];
  return undefined;
}

/** External fields render only a link and carry no answer, so they must never block Submit. */
function isMissing(f: FormField, v: FormValue | undefined): boolean {
  if (f.type === "external") return false;
  if (v === undefined || v === "") return true;
  // `initialValue` gives multiselects an empty array, so a required one must not be submittable
  // before the user has picked anything.
  if (f.type === "multiselect" && Array.isArray(v) && v.length === 0) return true;
  return (f.type === "number" || f.type === "integer") && typeof v === "number" && !Number.isFinite(v);
}

function numericValue(raw: string): FormValue | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Collects every field (including hidden ones with their defaults) into the single form reply. */
export function buildFormAnswer(
  form: FormRequest,
  values: Record<string, FormValue | undefined>,
  custom: Record<string, string>,
): Record<string, FormValue> {
  const answer: Record<string, FormValue> = {};
  for (const f of form.fields) {
    let v = values[f.key];
    // Only rewrite our sentinel when it is not a legitimate option value.
    if (v === "__custom__" && !f.options?.some((o) => o.value === "__custom__")) v = custom[f.key] ?? "";
    if (v !== undefined) answer[f.key] = v;
  }
  return answer;
}

/**
 * One field of a question form, shown on its own in the attention overlay.
 *
 * A `question` tool can bundle several questions in one server-side form, so the answers are owned
 * by the overlay (one reply is posted for the whole form at the end) and this card only renders the
 * current field. The last card submits; earlier ones just move to the next question.
 */
export function QuestionCard({
  form,
  field,
  value,
  custom,
  busy,
  last,
  onChange,
  onCustom,
  onNext,
  onSubmit,
  onCancel,
}: {
  form: FormRequest;
  field?: FormField;
  value: FormValue | undefined;
  custom: string;
  busy: boolean;
  last: boolean;
  onChange: (v: FormValue | undefined) => void;
  onCustom: (v: string) => void;
  onNext: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const failed = useReplyFailed("form", form.id);
  const disabled = busy && !failed;
  const missing = field ? field.required && isMissing(field, value) : false;
  const labelId = `form-${form.id}`;
  return (
    <form
      class="card question"
      aria-labelledby={labelId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !missing) onSubmit();
      }}
    >
      <div class="card-title" id={labelId}>
        <IconInfo /> {form.title || t("questionTitle")}
      </div>
      {field && <FieldInput field={field} value={value} onChange={onChange} custom={custom} onCustom={onCustom} resetKey={form.id} />}
      <div class="card-actions">
        {last ? (
          <button type="submit" class="primary" disabled={disabled || missing}>
            {t("submit")}
          </button>
        ) : (
          <button type="button" class="primary" disabled={missing} onClick={onNext}>
            {t("nextQuestion")}
          </button>
        )}
        <button type="button" class="secondary" disabled={disabled} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function FieldInput(props: {
  field: FormField;
  value: FormValue | undefined;
  onChange: (v: FormValue | undefined) => void;
  custom: string;
  onCustom: (v: string) => void;
  resetKey: string;
}) {
  const { field: f, value, onChange } = props;
  const t = useT();
  const id = `field-${f.key}`;
  const label = (
    <>
      <span class="field-title">{f.title ?? f.key}</span>
      {f.description && <span class="field-desc">{f.description}</span>}
    </>
  );
  if (f.type === "external") {
    return (
      <div class="field">
        {label}
        {f.url && (
          <button type="button" class="link-button" onClick={() => post({ type: "openLink", href: f.url! })}>
            {f.url}
          </button>
        )}
      </div>
    );
  }
  if (f.type === "boolean") {
    return (
      <label class="field inline" for={id}>
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        {label}
      </label>
    );
  }
  if (f.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset class="field">
        <legend>{label}</legend>
        {(f.options ?? []).map((o) => (
          <label class="option" key={o.value}>
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange((e.target as HTMLInputElement).checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))
              }
            />
            <span class="option-text">
              <span class="option-label">{o.label}</span>
              {o.description && <span class="field-desc">{o.description}</span>}
            </span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (f.type === "string" && f.options && f.options.length > 0) {
    return (
      <fieldset class="field">
        <legend>{label}</legend>
        {f.options.map((o) => (
          <label class="option" key={o.value}>
            <input type="radio" name={id} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span class="option-text">
              <span class="option-label">{o.label}</span>
              {o.description && <span class="field-desc">{o.description}</span>}
            </span>
          </label>
        ))}
        {f.custom && (
          <label class="option">
            <input type="radio" name={id} checked={value === "__custom__"} onChange={() => onChange("__custom__")} />
            <input
              type="text"
              class="text-input"
              placeholder={t("customAnswer")}
              value={props.custom}
              onFocus={() => onChange("__custom__")}
              onInput={(e) => props.onCustom((e.target as HTMLInputElement).value)}
              onKeyDown={isolateKeys}
              onKeyUp={isolateKeys}
            />
          </label>
        )}
      </fieldset>
    );
  }
  const numeric = f.type === "number" || f.type === "integer";
  const common = {
    id,
    class: "text-input",
    placeholder: f.placeholder,
    onKeyDown: isolateKeys,
    onKeyUp: isolateKeys,
  };
  return (
    <label class="field" for={id}>
      {label}
      {numeric ? (
        <NumericFieldInput key={props.resetKey} id={id} field={f} value={value} onChange={onChange} />
      ) : (
        <input
          {...common}
          type="text"
          value={value === undefined ? "" : String(value)}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      )}
    </label>
  );
}

/** Keeps the raw text while typing: `Number("-")` is NaN and would erase the sign mid-entry. */
function NumericFieldInput(props: {
  id: string;
  field: FormField;
  value: FormValue | undefined;
  onChange: (v: FormValue | undefined) => void;
}) {
  const { id, field, value, onChange } = props;
  const [raw, setRaw] = useState(value === undefined ? "" : String(value));
  return (
    <input
      id={id}
      class="text-input"
      type="number"
      step={field.type === "integer" ? 1 : "any"}
      placeholder={field.placeholder}
      value={raw}
      onKeyDown={isolateKeys}
      onKeyUp={isolateKeys}
      onInput={(e) => {
        const next = (e.target as HTMLInputElement).value;
        setRaw(next);
        onChange(numericValue(next));
      }}
      onBlur={() => {
        if (raw !== "" && numericValue(raw) === undefined) setRaw(value === undefined ? "" : String(value));
      }}
    />
  );
}
