import { useEffect, useState } from "preact/hooks";
import type { FormField, FormRequest, FormValue, PermissionRequest } from "../../shared/api";
import { fileRefToOpenPath, isFileRef } from "../../shared/fileRef";

import { isImeKey } from "../../shared/keys";

import { isolateKeys } from "../env";

import { useT } from "../i18n";
import { IconInfo, IconWarning } from "../icons";

import { clearReplyFailure, useReplyFailed } from "../replyFeedback";
import { post } from "../vscode";

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

import { FileList } from "./files";
