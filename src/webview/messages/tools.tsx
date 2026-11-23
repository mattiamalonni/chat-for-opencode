import { toolOutputLabel } from "../../shared/toolOutput";
import { useEffect, useMemo, useState } from "preact/hooks";
import { formsForTool, permissionsForTool, selectToolFiles, type ChatState, type ToolPart } from "../../shared/chatReducer";
import { fileRefToOpenPath, isFileRef } from "../../shared/fileRef";

import { isSubagentTool, subagentChildId, subagentView, toolInputSummary, type SubagentActivity } from "../../shared/subagents";
import { env } from "../env";

import { useT } from "../i18n";
import { IconCheck, IconChevron, IconError, IconOpen, IconTool, IconWarning } from "../icons";

import { useOpenSubagent, useSubagent } from "../subagents";
import { post } from "../vscode";

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
  const output = useMemo(() => part.output.map((c) => toolOutputLabel(c)).join("\n"), [part.output]);
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

import { Highlight } from "./text";

import { FileList } from "./files";
