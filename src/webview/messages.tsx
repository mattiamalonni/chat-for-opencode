import { useEffect, useMemo, useState } from "preact/hooks";
import type { FormField, FormRequest, FormValue, PermissionRequest } from "../shared/api";
import {
  formsForTool,
  permissionsForTool,
  selectToolFiles,
  type ChatState,
  type ChangedFile,
  type TextPart,
  type ToolPart,
  type UiAssistantMessage,
  type UiMessage,
  type UiNotice,
} from "../shared/chatReducer";
import type { ActionId } from "../shared/protocol";
import { isolateKeys } from "./env";
import { FileTypeIcon } from "./fileIcons";
import { useT } from "./i18n";
import { IconCheck, IconChevron, IconDiff, IconError, IconInfo, IconSelection, IconTool, IconWarning } from "./icons";
import { renderMarkdown } from "./markdown";
import { clearReplyFailure, useReplyFailed } from "./replyFeedback";
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

export function MessageView({
  message,
  state,
  grouped,
  showStatus = true,
}: {
  message: UiMessage;
  state: ChatState;
  grouped: boolean;
  showStatus?: boolean;
}) {
  const t = useT();
  if (message.kind === "user") {
    return (
      <article class="msg user" aria-label={t("you")}>
        <div class="bubble">
          <div class="user-text">{message.text}</div>
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
  if (message.kind === "notice") return <NoticeView notice={message} />;
  return <AssistantView message={message} state={state} grouped={grouped} showStatus={showStatus} />;
}

function NoticeView({ notice }: { notice: UiNotice }) {
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
    <div class={`notice ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
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

function AssistantView({
  message,
  state,
  grouped,
  showStatus = true,
}: {
  message: UiAssistantMessage;
  state: ChatState;
  grouped: boolean;
  showStatus?: boolean;
}) {
  const t = useT();
  return (
    <article class={`msg assistant${grouped ? " grouped" : ""}`} aria-label={t("assistant")} aria-busy={!message.done}>
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
export function AssistantStatus({ message, typing }: { message: UiAssistantMessage; typing?: boolean }) {
  const t = useT();
  return (
    <>
      {typing && !message.done && (
        <div class="typing" aria-label={t("thinking")}>
          <span />
          <span />
          <span />
        </div>
      )}
      {message.retry && (
        <div class="notice warning" role="status">
          <IconWarning />
          {t("retrying", message.retry.attempt, message.retry.message)}
        </div>
      )}
      {message.error && (
        <div class="notice error" role="alert">
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
  const input = part.input;
  if (input) {
    for (const k of SUMMARY_KEYS) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v.split("\n")[0].slice(0, 120);
    }
    if (Array.isArray(input.todos)) return `${input.todos.length} todos`;
  }
  return "";
}

export function ToolGroup({ parts, state }: { parts: ToolPart[]; state: ChatState }) {
  const t = useT();
  const needsUser = parts.some((p) => permissionsForTool(state, p.id).length > 0 || formsForTool(state, p.id).length > 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (needsUser) setOpen(true);
  }, [needsUser]);
  const expanded = open || needsUser;
  const running = parts.some((p) => p.status === "running" || p.status === "streaming");
  const failed = parts.some((p) => p.status === "error");
  const status = running ? "running" : failed ? "error" : "completed";
  const statusLabel = running ? t("running") : failed ? t("failed") : t("completed");
  const names = [...new Set(parts.map((p) => p.name))].join(", ");
  const id = `tool-group-${parts[0].id}`;
  return (
    <section class={`tool-group${needsUser ? " attention" : ""}`}>
      <button type="button" class="tool-header tool-group-header" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
        <IconChevron class="chevron" />
        <span class={`status-dot ${status}`} role="img" aria-label={statusLabel} title={statusLabel}>
          {status === "completed" ? <IconCheck /> : status === "error" ? <IconError /> : <IconTool />}
        </span>
        <span class="tool-name">{t("toolCalls", parts.length)}</span>
        <span class="tool-summary" title={names}>{names}</span>
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

export function ToolCard({ part, state }: { part: ToolPart; state: ChatState }) {
  const t = useT();
  const permissions = permissionsForTool(state, part.id);
  const forms = formsForTool(state, part.id);
  const needsUser = permissions.length > 0 || forms.length > 0;
  const [open, setOpen] = useState(false);
  const files = selectToolFiles(part);
  const expanded = open || needsUser;
  // When a question is pending, the FormCard already renders the same
  // information in a friendly way — showing the raw JSON input too is noise.
  const showInput = part.inputText && forms.length === 0;
  const summary = toolSummary(part);
  const statusLabel =
    part.status === "completed" ? t("completed") : part.status === "error" ? t("failed") : needsUser ? t("pending") : t("running");
  const output = part.output
    .map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`))
    .join("\n");
  const id = `tool-${part.id}`;
  return (
    <section class={`tool ${part.status}${needsUser ? " attention" : ""}`} aria-label={`${t("tool")}: ${part.name}`}>
      <button type="button" class="tool-header" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
        <IconChevron class="chevron" />
        <span class={`status-dot ${part.status}`} role="img" aria-label={statusLabel} title={statusLabel}>
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
        <li key={f.file}>
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
  return (
    <div class="card permission" role="group" aria-labelledby={labelId}>
      <div class="card-title" id={labelId}>
        <IconWarning /> {t("permissionTitle")}: <code>{request.action}</code>
      </div>
      {request.message && <p class="card-text">{request.message}</p>}
      {request.resources.length > 0 && (
        <ul class="resources" aria-label={t("permissionResources")}>
          {request.resources.map((r) => (
            <li key={r}>
              <code>{r}</code>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && <FileList files={files} applied={false} />}
      <div class="card-actions">
        <button type="button" class="primary" disabled={disabled} onClick={() => reply("once")}>
          {t("permissionAllowOnce")}
        </button>
        {(request.save?.length ?? 0) > 0 && (
          <button type="button" class="secondary" disabled={disabled} onClick={() => reply("always")}>
            {t("permissionAllowAlways")}
          </button>
        )}
        <button type="button" class="secondary danger" disabled={disabled} onClick={() => reply("reject")}>
          {t("permissionReject")}
        </button>
      </div>
    </div>
  );
}

function initialValue(f: FormField): FormValue | undefined {
  if (f.default !== undefined) return f.default as FormValue;
  if (f.type === "boolean") return false;
  if (f.type === "multiselect") return [];
  return undefined;
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
  const set = (k: string, v: FormValue | undefined) => setValues((prev) => ({ ...prev, [k]: v }));
  const missing = fields.some((f) => f.required && (values[f.key] === undefined || values[f.key] === ""));
  const disabled = busy && !failed;
  const submit = (e: Event) => {
    e.preventDefault();
    const answer: Record<string, FormValue> = {};
    for (const f of form.fields) {
      let v = values[f.key];
      if (v === "__custom__") v = custom[f.key] ?? "";
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
      onChange(numeric ? (raw === "" ? undefined : Number(raw)) : raw);
    },
  };
  return (
    <label class="field" for={id}>
      {label}
      {numeric ? <input {...common} type="number" step={f.type === "integer" ? 1 : "any"} /> : <input {...common} type="text" />}
    </label>
  );
}
