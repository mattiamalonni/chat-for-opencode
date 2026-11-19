import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FormField, FormRequest, FormValue, PermissionRequest } from "../shared/api";
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
import {
  isSubagentTool,
  subagentChildId,
  subagentView,
  toolObject,
  type SubagentActivity,
} from "../shared/subagents";
import { isolateKeys } from "./env";
import { FileTypeIcon } from "./fileIcons";
import { useT } from "./i18n";
import { IconCheck, IconChevron, IconDiff, IconError, IconFile, IconInfo, IconSelection, IconTool, IconWarning } from "./icons";
import { renderMarkdown } from "./markdown";
import { clearReplyFailure, useReplyFailed } from "./replyFeedback";
import { useSubagent } from "./subagents";
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

/** Highlights a query in plain text. Markdown bodies keep their rendered HTML and are not rewritten. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const children: (string | ComponentChildren)[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  let i = 0;
  while (at !== -1) {
    if (at > from) children.push(text.slice(from, at));
    children.push(<mark key={`m${i++}`}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) children.push(text.slice(from));
  return <>{children}</>;
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
    return (
      <article class={`msg user${hidden}`} aria-label={t("you")}>
        <div class="bubble">
          <div class="user-text"><Highlight text={message.text} query={searchQuery} /></div>
          {message.files.length > 0 && (
            <ul class="chips" aria-label={t("context")}>
              {message.files.map((f) => {
                // Older/foreign payloads may lack a location; render the chip instead of crashing.
                const uri = f.uri ?? "";
                const name = f.name ?? (uri ? fileNameOf(uri) : "");
                return (
                  <li class="chip readonly" key={uri || name} title={uri || name}>
                    {uri.includes("?start=") ? <IconSelection /> : <FileTypeIcon path={name || uri} />}
                    <span>{name}</span>
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
  return <AssistantView message={message} state={state} grouped={grouped} showStatus={showStatus} filteredOut={filteredOut} />;
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

/** Wall-clock time and total usage for a whole user turn, from input to the last step. */
export function TurnStatsRow({ stats }: { stats: TurnStats }) {
  if (stats.ended === undefined) return null;
  return <StatsRow stats={stats} />;
}

/** Has to be a component: `useT` is a hook. The guard above keeps unfinished turns invisible. */
function StatsRow({ stats }: { stats: TurnStats }) {
  const t = useT();
  const total = stats.tokens && stats.tokens.input + stats.tokens.output + stats.tokens.reasoning + stats.tokens.cache.read + stats.tokens.cache.write;
  const elapsed = Math.max(0, (stats.ended ?? 0) - stats.started);

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
  const tokens = total && total > 0 ? t("tokens", formatTokens(total)) : undefined;
  const cost = stats.cost !== undefined && stats.cost > 0 ? `$${stats.cost.toFixed(stats.cost < 0.01 ? 4 : 2)}` : undefined;
  const shown = [duration, tokens, cost].filter((x): x is string => x !== undefined);
  const tooltip = t(
    "turnStatsTooltip",
    duration,
    tokens ?? t("turnStatsUnknown"),
    cost ?? t("turnStatsUnknown"),
  );
  return (
    <div class="turn-stats tooltip-host tooltip-above" role="img" aria-label={tooltip} data-tooltip={tooltip}>
      <span class="turn-stats-line" aria-hidden="true" />
      <span class="turn-stats-text">{shown.join(" · ")}</span>
      <span class="turn-stats-line" aria-hidden="true" />
    </div>
  );
}

function AssistantView({
  message,
  state,
  grouped,
  showStatus = true,
  filteredOut = false,
}: {
  message: UiAssistantMessage;
  state: ChatState;
  grouped: boolean;
  showStatus?: boolean;
  filteredOut?: boolean;
}) {
  const t = useT();
  return (
    <article class={`msg assistant${grouped ? " grouped" : ""}${filteredOut ? " filtered-out" : ""}`} aria-label={t("assistant")} aria-busy={!message.done}>
      {message.parts.map((p) =>
        p.kind === "tool" ? (
          <ToolCard key={p.key} part={p} state={state} />
        ) : p.kind === "reasoning" ? (
          <Reasoning key={p.key} part={p} />
        ) : (
          <Markdown key={p.key} text={p.text} />
        ),
      )}
      {showStatus && <AssistantStatus message={message} typing={message.parts.length === 0} />}
    </article>
  );
}

/** Retry/error feedback and the waiting indicator, shared by whole and split assistant messages. */
export function AssistantStatus({ message, typing, filteredOut = false }: { message: UiAssistantMessage; typing?: boolean; filteredOut?: boolean }) {
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

const SUMMARY_KEYS = ["description", "filePath", "path", "file", "command", "pattern", "query", "url", "name", "prompt"];

export function toolSummary(part: ToolPart): string {
  const input = toolObject(part);
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0].slice(0, 120);
  }
  if (Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return "";
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

export function ToolGroup({ parts, state, filteredOut = false }: { parts: ToolPart[]; state: ChatState; filteredOut?: boolean }) {
  const t = useT();
  const needsUser = parts.some((p) => permissionsForTool(state, p.id).length > 0 || formsForTool(state, p.id).length > 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (needsUser) setOpen(true);
  }, [needsUser]);
  const subagentPart = parts.find(isSubagentTool);
  const subEntry = useSubagent(subagentPart ? subagentChildId(subagentPart) : undefined);
  const sub = subagentPart ? subagentView(subagentPart, subEntry?.state, subEntry?.meta, state.subagentReports) : undefined;
  const expanded = open || needsUser;
  const running = parts.some((p) => p.status === "running" || p.status === "streaming");
  const failed = parts.some((p) => p.status === "error");
  const status = sub ? subagentDot(sub.status) : running ? "running" : failed ? "error" : "completed";
  const statusLabel = sub
    ? sub.status === "error"
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
  const headerSummary = sub ? [sub.title, activityText(sub.activity, t)].filter(Boolean).join(" · ") : names;
  const id = `tool-group-${parts[0].id}`;
  return (
    <section class={`tool-group${sub ? " subagent" : ""}${needsUser ? " attention" : ""}${filteredOut ? " filtered-out" : ""}`}>
      <button type="button" class="tool-header tool-group-header" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
        <IconChevron class="chevron" />
        <span class={`status-dot ${status} tooltip-host`} role="img" aria-label={statusLabel} data-tooltip={statusLabel}>
          {status === "completed" ? <IconCheck /> : status === "error" ? <IconError /> : <IconTool />}
        </span>
        {sub && <span class="subagent-badge">{t("subagent")}</span>}
        <span class="tool-name">{headerName}</span>
        <span class="tool-summary" title={headerSummary}>{headerSummary}</span>
      </button>
      {expanded && (
        <div class="tool-group-body" id={id}>
          {parts.map((p) => (
            <ToolCard key={p.key} part={p} state={state} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Dispatch on the tool name so hook order stays stable for each card. */
export function ToolCard(props: { part: ToolPart; state: ChatState; filteredOut?: boolean }) {
  return isSubagentTool(props.part)
    ? <SubagentToolCard part={props.part} state={props.state} filteredOut={props.filteredOut} />
    : <GenericToolCard {...props} />;
}

/** The tool result wraps the child report in a `<subagent>` tag; the child's own text is plain. */
function stripSubagentWrapper(text: string): string {
  return text.replace(/^\s*<subagent\b[^>]*>\s*/i, "").replace(/\s*<\/subagent>\s*$/i, "");
}

/** A subagent call stays one line until expanded; its child's progress is shown on demand. */
function SubagentToolCard({ part, state, filteredOut = false }: { part: ToolPart; state: ChatState; filteredOut?: boolean }) {
  const t = useT();
  const sessionId = subagentChildId(part);
  const entry = useSubagent(sessionId);
  const view = useMemo(() => subagentView(part, entry?.state, entry?.meta, state.subagentReports), [part, entry, state.subagentReports]);
  const [open, setOpen] = useState(false);
  const running = view.status === "running" || view.status === "pending";
  const now = useNow(running);
  const dot = subagentDot(view.status);
  const elapsed = view.started === undefined ? undefined : `${Math.max(0, Math.round(((view.ended ?? now) - view.started) / 1000))}s`;
  const statusLabel =
    view.status === "error"
      ? t("failed")
      : view.status === "cancelled"
        ? t("cancelled")
        : view.status === "completed"
          ? t("completed")
          : t("running");
  const header = [view.agent || t("subagent"), view.title, activityText(view.activity, t), elapsed].filter(Boolean).join(" · ");
  const id = `subagent-${part.id}`;
  return (
    <section class={`tool subagent ${dot}${filteredOut ? " filtered-out" : ""}`} aria-label={`${t("subagent")}: ${header}`}>
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
          {dot === "completed" ? <IconCheck /> : dot === "error" ? <IconError /> : <IconTool />}
        </span>
        <span class="subagent-badge">{t("subagent")}</span>
        <span class="tool-summary" title={header}>{header}</span>
      </button>
      {open && (
        <div class="tool-body subagent-body" id={id}>
          <div class="subagent-activity">
            <span class="tool-label">{t("activity")}</span>
            <span>{activityText(view.activity, t)}{elapsed ? ` · ${elapsed}` : ""}</span>
          </div>
          {view.task && (
            <details class="tool-section">
              <summary class="tool-label">{t("task")}</summary>
              <pre class="tool-pre">{view.task}</pre>
            </details>
          )}
          {view.tools.length > 0 && (
            <div class="tool-section">
              <div class="tool-label">{t("steps")} ({view.tools.length})</div>
              <ul class="subagent-steps">
                {view.tools.map((tool, i) => (
                  <li class={`subagent-step ${tool.status}`} key={`${tool.name}-${i}`}>
                    <span class={`status-dot ${subagentDot(tool.status)}`} />
                    <span class="step-name">{tool.name}</span>
                    {tool.summary && <span class="step-summary" title={tool.summary}>{tool.summary}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.report && (
            <div class="tool-section">
              <div class="tool-label">{t("report")}</div>
              <TruncatedPre text={stripSubagentWrapper(view.report)} />
            </div>
          )}
          <details class="tool-section">
            <summary class="tool-label">{t("input")}</summary>
            <pre class="tool-pre">{part.inputText}</pre>
          </details>
        </div>
      )}
    </section>
  );
}

function GenericToolCard({ part, state, filteredOut = false }: { part: ToolPart; state: ChatState; filteredOut?: boolean }) {
  const t = useT();
  const permissions = permissionsForTool(state, part.id);
  const forms = formsForTool(state, part.id);
  const needsUser = permissions.length > 0 || forms.length > 0;
  const [open, setOpen] = useState(false);
  const files = useMemo(() => selectToolFiles(part), [part.metadata]);
  const expanded = open || needsUser;
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
    <section class={`tool ${part.status}${needsUser ? " attention" : ""}${filteredOut ? " filtered-out" : ""}`} aria-label={`${t("tool")}: ${part.name}`}>
      <button type="button" class="tool-header" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
        <IconChevron class="chevron" />
        <span class={`status-dot ${part.status} tooltip-host`} role="img" aria-label={statusLabel} data-tooltip={statusLabel}>
          {part.status === "completed" ? <IconCheck /> : part.status === "error" ? <IconError /> : <IconTool />}
        </span>
        <span class="tool-name">{part.name}</span>
        <span class="tool-summary" title={summary}>{summary}</span>
      </button>
      {expanded && (
        <div class="tool-body" id={id}>
          {showInput && (
            <div class="tool-section">
              <div class="tool-label">{t("input")}</div>
              <pre class="tool-pre">{part.inputText}</pre>
            </div>
          )}
          {output && (
            <div class="tool-section">
              <div class="tool-label">{t("output")}</div>
              <TruncatedPre text={output} />
            </div>
          )}
          {part.error && part.error.message && (
            <div class="tool-section">
              <div class="tool-label">{t("error")}</div>
              <pre class="tool-pre error-text">{part.error.message}</pre>
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
      {permissions.map((p) => <PermissionCard key={p.id} request={p} />)}
      {forms.map((f) => <FormCard key={f.id} form={f} />)}
    </section>
  );
}

function TruncatedPre({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const limit = 4000;
  const t = useT();
  if (text.length <= limit || full) return <pre class="tool-pre">{text}</pre>;
  return (
    <div>
      <pre class="tool-pre">{text.slice(0, limit)}…</pre>
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
      {files.map((f) => (
        <li key={f.file} class="file-item">
          {f.patch ? (
            <button
              type="button"
              class="file-row"
              title={`${t("openDiff")}: ${f.file}`}
              onClick={() => post({ type: "openDiff", file: f.file, patch: f.patch, applied })}
            >
              <IconDiff />
              <span class="file-name">{f.file}</span>
              <span class="adds">+{f.additions}</span>
              <span class="dels">-{f.deletions}</span>
            </button>
          ) : (
            <span class="file-row" title={t("noDiffAvailable")}>
              <IconDiff />
              <span class="file-name">{f.file}</span>
            </span>
          )}
          <button
            type="button"
            class="file-open tooltip-host"
            aria-label={t("openFile")}
            data-tooltip={`${t("openFile")}: ${f.file}`}
            onClick={() => post({ type: "openFile", path: f.file })}
          >
            <IconFile />
          </button>
        </li>
      ))}
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
    if (e.isComposing || isImeKey(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || disabled) return;
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
        <span class="shortcut-hint" aria-hidden="true">{hasAlways ? t("permissionShortcutHint") : t("permissionShortcutHintNoAlways")}</span>
      </div>
    </div>
  );
}

function initialValue(f: FormField): FormValue | undefined {
  const d = f.default;
  if (d !== undefined) {
    // A malformed default (null, object, array for a string field) must not leak into the input as
    // "[object Object]" or be submitted verbatim.
    switch (f.type) {
      case "boolean": return typeof d === "boolean" ? d : false;
      case "multiselect": return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
      case "number":
      case "integer": return typeof d === "number" && Number.isFinite(d) ? d : undefined;
      case "external": return undefined;
      default: return typeof d === "string" || (typeof d === "number" && Number.isFinite(d)) ? (d as FormValue) : undefined;
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
  return (f.type === "number" || f.type === "integer") && typeof v === "number" && !Number.isFinite(v);
}

function numericValue(raw: string): FormValue | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function FormCard({ form }: { form: FormRequest }) {
  const t = useT();
  const fields = form.fields.filter((f) => !f.hidden);
  const [values, setValues] = useState<Record<string, FormValue | undefined>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.key, initialValue(f)])),
  );
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const failed = useReplyFailed("form", form.id);
  // A resync re-posts the same pending form as a fresh object: re-enable its buttons.
  useEffect(() => setBusy(false), [form]);
  // If a resync regenerates fields (new keys/defaults) under the same id, re-derive the answers.
  // Keying only on the cheap signature avoids wiping the user's input on a normal resync.
  const fieldsSignature = form.fields
    .map((f) => `${f.key}\u0000${f.type}\u0000${f.required ? 1 : 0}\u0000${JSON.stringify(f.default) ?? ""}`)
    .join("\u0001");
  const appliedSignature = useRef(fieldsSignature);
  useEffect(() => {
    if (appliedSignature.current === fieldsSignature) return;
    appliedSignature.current = fieldsSignature;
    setValues(Object.fromEntries(form.fields.map((f) => [f.key, initialValue(f)])));
    setCustom({});
    setBusy(false);
  }, [fieldsSignature]);
  const set = (k: string, v: FormValue | undefined) => setValues((prev) => ({ ...prev, [k]: v }));
  const missing = fields.some((f) => f.required && isMissing(f, values[f.key]));
  const disabled = busy && !failed;
  const submit = (e: Event) => {
    e.preventDefault();
    const answer: Record<string, FormValue> = {};
    for (const f of form.fields) {
      let v = values[f.key];
      // Only rewrite our sentinel when it is not a legitimate option value.
      if (v === "__custom__" && !f.options?.some((o) => o.value === "__custom__")) v = custom[f.key] ?? "";
      if (v !== undefined) answer[f.key] = v;
    }
    clearReplyFailure({ kind: "form", id: form.id });
    setBusy(true);
    post({ type: "formReply", sessionId: form.sessionID, formId: form.id, answer });
  };
  const labelId = `form-${form.id}`;
  return (
    <form class="card question" aria-labelledby={labelId} onSubmit={submit}>
      <div class="card-title" id={labelId}>
        <IconInfo /> {form.title || t("questionTitle")}
      </div>
      {fields.map((f) => (
        <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} custom={custom[f.key] ?? ""} onCustom={(v) => setCustom((c) => ({ ...c, [f.key]: v }))} />
      ))}
      <div class="card-actions">
        <button type="submit" class="primary" disabled={disabled || missing}>
          {t("submit")}
        </button>
        <button
          type="button"
          class="secondary"
          disabled={disabled}
          onClick={() => {
            clearReplyFailure({ kind: "form", id: form.id });
            setBusy(true);
            post({ type: "formCancel", sessionId: form.sessionID, formId: form.id });
          }}
        >
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
    value: value === undefined ? "" : String(value),
    onKeyDown: isolateKeys,
    onKeyUp: isolateKeys,
    onInput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      onChange(numeric ? numericValue(raw) : raw);
    },
  };
  return (
    <label class="field" for={id}>
      {label}
      {numeric ? <input {...common} type="number" step={f.type === "integer" ? 1 : "any"} /> : <input {...common} type="text" />}
    </label>
  );
}
