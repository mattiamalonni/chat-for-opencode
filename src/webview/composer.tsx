import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentInfo, ModelInfo, ModelRef, SkillSuggestion } from "../shared/api";
import { composerAction } from "../shared/keys";
import type { Attachment, ContextItem } from "../shared/protocol";
import { isolateKeys } from "./env";
import { formatTokens } from "../shared/format";
import { ContextMeter } from "./contextMeter";
import { FileTypeIcon } from "./fileIcons";
import { Picker } from "./picker";
import { useT } from "./i18n";
import { IconAt, IconClose, IconSelection, IconSend, IconStop, IconTool } from "./icons";
import { getPersisted, post, setPersisted } from "./vscode";

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  models: ModelInfo[];
  agents: AgentInfo[];
  skills: SkillSuggestion[];
  selectedModel?: ModelRef;
  selectedAgent?: string;
  context: ContextItem[];
  excluded: Set<string>;
  onExclude: (id: string) => void;
  attachments: Attachment[];
  onRemoveAttachment: (uri: string) => void;
  onAddAttachment: (a: Attachment) => void;
  fileResults: { query: string; items: Attachment[] };
  onSend: (text: string) => void;
  focusToken: number;
  /** Estimated tokens currently in the session context. */
  contextTokens?: number;
}

const FILE_MENTION_RE = /(^|\s)@([^\s@]*)$/;
const SKILL_COMMAND_RE = /(^|\s)\/([^\s/]*)$/;

type MentionItem = { kind: "file"; item: Attachment } | { kind: "skill"; item: SkillSuggestion };
type Mention = { query: string; start: number; kind: "file" | "skill" };

export function Composer(props: ComposerProps) {
  const t = useT();
  const [text, setText] = useState(() => getPersisted().draft ?? "");
  const [mention, setMention] = useState<Mention | undefined>();
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    ref.current?.focus();
  }, [props.focusToken]);

  useEffect(() => {
    const handle = setTimeout(() => setPersisted({ ...getPersisted(), draft: text }), 300);
    return () => clearTimeout(handle);
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!mention) return;
    if (mention.kind !== "file") return;
    const handle = setTimeout(() => post({ type: "searchFiles", query: mention.query }), 100);
    return () => clearTimeout(handle);
  }, [mention?.query]);

  const fileResults = mention?.kind === "file" && props.fileResults.query === mention.query ? props.fileResults.items : [];
  const skillResults: SkillSuggestion[] = mention?.kind === "skill"
    ? props.skills
        .filter((skill) => `${skill.id} ${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 30)
    : [];
  const results: MentionItem[] = [
    ...(mention?.kind === "skill" || mention?.kind === "file" ? skillResults : []).map((item): MentionItem => ({ kind: "skill", item })),
    ...fileResults.map((item): MentionItem => ({ kind: "file", item })),
  ];
  useEffect(() => setActive(0), [results.length, mention?.query]);

  const updateMention = (value: string, caret: number) => {
    const beforeCaret = value.slice(0, caret);
    const skillMatch = SKILL_COMMAND_RE.exec(beforeCaret);
    const fileMatch = FILE_MENTION_RE.exec(beforeCaret);
    const match = skillMatch ?? fileMatch;
    setMention(
      match
        ? {
            query: match[2],
            start: caret - match[2].length - 1,
            kind: skillMatch ? "skill" : "file",
          }
        : undefined,
    );
  };

  const pick = (item: MentionItem) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const label = item.kind === "skill" ? `${mention.kind === "skill" ? "/" : "@"}${item.item.id} ` : `@${item.item.detail ?? item.item.name} `;
    const next = text.slice(0, mention.start) + label + text.slice(caret);
    setText(next);
    setMention(undefined);
    if (item.kind === "file") props.onAddAttachment(item.item);
    requestAnimationFrame(() => {
      const pos = mention.start + label.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const send = () => {
    const value = text.trim();
    if (!value || props.disabled) return;
    if (props.busy) return;
    props.onSend(value);
    setText("");
    setMention(undefined);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    isolateKeys(e);
    if (mention && results.length > 0 && !composing.current && !e.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % results.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + results.length) % results.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        pick(results[active]);
        return;
      }
    }
    if (mention && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMention(undefined);
      return;
    }
    if (e.key === "Escape" && props.busy) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: "abort" });
      return;
    }
    const action = composerAction(e, composing.current);
    if (action === "send") {
      e.preventDefault();
      send();
    }
  };

  const visibleContext = props.context.filter((c) => !props.excluded.has(c.id));
  const modelItems = useMemo(
    () =>
      [...props.models]
        .sort((a, b) => a.providerID.localeCompare(b.providerID))
        .map((m) => ({
          value: `${m.providerID}/${m.id}`,
          label: m.name,
          group: m.providerID,
          description: m.id,
          meta: m.limit?.context ? formatTokens(m.limit.context) : undefined,
          metaLabel: m.limit?.context ? t("contextWindow", formatTokens(m.limit.context)) : undefined,
        })),
    // `t` is a new function each render; depend on the translated template instead.
    [props.models, t("contextWindow", "")],
  );
  const modelKey = props.selectedModel ? `${props.selectedModel.providerID}/${props.selectedModel.id}` : "";
  const currentModel = props.models.find((m) => `${m.providerID}/${m.id}` === modelKey);
  const listId = "mention-list";

  return (
    <div class="composer">
      <div class="composer-box">
      {(visibleContext.length > 0 || props.attachments.length > 0) && (
        <ul class="chips" aria-label={t("context")}>
          {visibleContext.map((c) => (
            <li class={`chip ${c.kind === "file" ? "implicit" : ""}`} key={c.id} title={c.detail ?? c.uri}>
              {c.kind === "selection" ? <IconSelection /> : <FileTypeIcon path={c.label} />}
              <span>{c.label}</span>
              <span class="chip-kind">{c.kind === "file" ? t("currentFile") : t("selection")}</span>
              <button type="button" class="chip-remove" aria-label={`${t("removeContext")}: ${c.label}`} onClick={() => props.onExclude(c.id)}>
                <IconClose />
              </button>
            </li>
          ))}
          {props.attachments.map((a) => (
            <li class="chip" key={a.uri} title={a.detail ?? a.uri}>
              {a.kind === "selection" ? <IconSelection /> : <FileTypeIcon path={a.name} />}
              <span>{a.kind === "selection" ? (a.detail ?? a.name) : a.name}</span>
              <button type="button" class="chip-remove" aria-label={`${t("removeContext")}: ${a.name}`} onClick={() => props.onRemoveAttachment(a.uri)}>
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="input-wrap">
        {mention && (
          <ul class="mention-popup" role="listbox" id={listId} aria-label={t("suggestions")}>
            {results.length === 0 ? (
              <li class="mention-empty" role="option" aria-disabled="true" aria-selected="false">
                {t("noFilesOrSkillsFound")}
              </li>
            ) : (
              results.map((r, i) => (
                <li
                  key={r.kind === "file" ? r.item.uri : `skill:${r.item.id}`}
                  id={`mention-${i}`}
                  role="option"
                  aria-selected={i === active}
                  class={i === active ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                >
                  {r.kind === "file" ? <FileTypeIcon path={r.item.detail ?? r.item.name} /> : <IconTool />}
                  <span class="mention-name">{r.item.name}</span>
                  <span class="mention-path">{r.kind === "file" ? r.item.detail : `@${r.item.id}${r.item.description ? ` · ${r.item.description}` : ""}`}</span>
                </li>
              ))
            )}
          </ul>
        )}
        <textarea
          ref={ref}
          class="input"
          rows={2}
          value={text}
          placeholder={t("inputPlaceholder")}
          aria-label={t("inputLabel")}
          aria-autocomplete="list"
          aria-expanded={!!mention}
          aria-controls={mention ? listId : undefined}
          aria-activedescendant={mention && results.length > 0 ? `mention-${active}` : undefined}
          disabled={props.disabled}
          onInput={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setText(el.value);
            if (!composing.current) updateMention(el.value, el.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            isolateKeys(e);
            const el = e.currentTarget as HTMLTextAreaElement;
            if ((e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") && !composing.current) {
              updateMention(el.value, el.selectionStart);
            }
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            // WebKit fires compositionend before the Enter keydown that confirms the IME candidate.
            setTimeout(() => (composing.current = false), 0);
            const el = e.currentTarget as HTMLTextAreaElement;
            updateMention(el.value, el.selectionStart);
          }}
          onBlur={() => setTimeout(() => setMention(undefined), 150)}
        />
      </div>
      <div class="toolbar">
        <button
          type="button"
          class="icon-button"
          title={t("attachFile")}
          aria-label={t("attachFile")}
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            const pos = el.selectionStart ?? text.length;
            const prefix = pos > 0 && !/\s$/.test(text.slice(0, pos)) ? " @" : "@";
            const next = text.slice(0, pos) + prefix + text.slice(pos);
            setText(next);
            const caret = pos + prefix.length;
            requestAnimationFrame(() => {
              el.focus();
              el.setSelectionRange(caret, caret);
              updateMention(next, caret);
            });
          }}
        >
          <IconAt />
        </button>
        {props.agents.length > 0 && (
          <Picker
            label={t("agent")}
            class="agent"
            items={props.agents.map((a) => ({ value: a.id, label: a.name, description: a.description }))}
            value={props.selectedAgent}
            onChange={(agent) => post({ type: "setAgent", agent })}
          />
        )}
        {props.models.length > 0 && (
          <Picker
            label={t("model")}
            class="model"
            searchable={props.models.length > 6}
            searchPlaceholder={t("searchModels")}
            emptyText={t("noModelsFound")}
            placeholder={t("model")}
            items={modelItems}
            value={modelKey}
            onChange={(key) => {
              const [providerID, ...rest] = key.split("/");
              post({ type: "setModel", model: { providerID, id: rest.join("/") } });
            }}
          />
        )}
        {currentModel && currentModel.variants.length > 0 && (
          <Picker
            label={t("variant")}
            class="variant"
            items={[{ value: "", label: t("defaultVariant") }, ...currentModel.variants.map((v) => ({ value: v.id, label: v.id }))]}
            value={props.selectedModel?.variant ?? ""}
            onChange={(v) =>
              post({
                type: "setModel",
                model: { providerID: currentModel.providerID, id: currentModel.id, ...(v ? { variant: v } : {}) },
              })
            }
          />
        )}
        <span class="spacer" />
        {currentModel?.limit?.context ? <ContextMeter used={props.contextTokens} limit={currentModel.limit.context} /> : null}
        {props.busy ? (
          <button type="button" class="send stop" title={`${t("stop")} (Esc)`} aria-label={t("stop")} onClick={() => post({ type: "abort" })}>
            <IconStop />
          </button>
        ) : (
          <button type="button" class="send" title={`${t("send")} (Enter)`} aria-label={t("send")} disabled={props.disabled || !text.trim()} onClick={send}>
            <IconSend />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
