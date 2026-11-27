import type { VNode } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentInfo, CommandSuggestion, ModelInfo, ModelRef, SkillSuggestion } from "../../shared/api";
import { composerAction } from "../../shared/keys";
import type { Attachment, ContextItem, PromptDefinition } from "../../shared/protocol";
import { isolateKeys } from "../env";
import { formatTokens } from "../../shared/format";

import { collectPastedFiles, hasFiles, readFileAsBase64, type DragData } from "../dropFiles";

import { useT } from "../i18n";
import { getDraft, post, setDraft } from "../vscode";

export interface ComposerProps {
  /** Id of the session the composer belongs to; drafts are stored per session. */
  sessionId?: string;
  /** The text came from a library prompt: its `$variables` are filled on send, so mark them. */
  variablesActive?: boolean;
  /** Bumped when the host restores drafts from workspaceState, so the input reloads them. */
  draftToken?: number;
  /** Prompt returned by a rollback; unlike `draftToken` this replaces even non-empty input. */
  restoredDraft?: { text: string; token: number };
  busy: boolean;
  /** A background shell is still running after the turn ended; the chat resumes on completion. */
  waitingShell?: boolean;
  disabled: boolean;
  models: ModelInfo[];
  agents: AgentInfo[];
  skills: SkillSuggestion[];
  commands: CommandSuggestion[];
  selectedModel?: ModelRef;
  selectedAgent?: string;
  /** Per-chat auto-approval of permission requests. */
  autoApprove: boolean;
  onToggleAutoApprove: (enabled: boolean) => void;
  context: ContextItem[];
  prompts: PromptDefinition[];
  selectedContext: Set<string>;
  onToggleContext: (id: string) => void;
  attachments: Attachment[];
  onRemoveAttachment: (uri: string) => void;
  onAddAttachment: (a: Attachment) => void;
  fileResults: { query: string; items: Attachment[] };
  onSend: (text: string, delivery?: "steer" | "queue") => void;
  /** Previously sent prompts, oldest first, recalled with Up/Down. */
  promptHistory: string[];
  focusToken: number;
  /** Bumped by Cmd/Ctrl+M to open the model picker. */
  modelPickerToken: number;
  /** A model was picked: move focus back to the composer. */
  onModelSelected: () => void;
  /** Estimated tokens currently in the session context. */
  contextTokens?: number;
  /** True when the estimate includes locally-added inline attachments. */
  contextEstimated?: boolean;
  /** Accumulated cost of the current session, when reported by the server. */
  cost?: number;
  /** A session is loaded and idle, so session-level actions (fork, compact) can be requested. */
  canActOnSession: boolean;
}

import { Chips } from "./chips";
import { promptVariableRanges } from "../../shared/promptVariables";
import { commandTokenRanges, FILE_MENTION_RE, SKILL_COMMAND_RE, type Mention, type MentionItem } from "./mention";
import { MentionPopup } from "./mentionPopup";
import { StatusBar } from "./statusBar";
import { Toolbar } from "./toolbar";

export function Composer(props: ComposerProps) {
  const t = useT();
  const [text, setText] = useState(() => getDraft(props.sessionId));
  const [mention, setMention] = useState<Mention | undefined>();
  const [active, setActive] = useState(0);
  // null = not browsing history; otherwise index into `props.promptHistory`.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraft = useRef("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const cancelBlurClose = () => {
    clearTimeout(blurTimer.current);
    blurTimer.current = undefined;
  };
  const draftRef = useRef(text);
  // The session whose draft `draftRef.current` belongs to; kept in sync in the switch effect.
  const sessionIdRef = useRef(props.sessionId);
  // Mirror the fast local state to the host's durable workspaceState.
  const persistDraft = (value: string, sessionId?: string) => {
    setDraft(value, sessionId);
    post({ type: "saveDraft", sessionId, text: value });
  };

  // Layout effect: a requested focus must land before the next paint, otherwise reopening the
  // session list right after closing it can be overruled by this still-pending passive effect.
  useLayoutEffect(() => {
    ref.current?.focus();
  }, [props.focusToken]);

  useEffect(() => {
    draftRef.current = text;
    // Capture the session here so a late debounce never writes into a newly selected session.
    const sessionId = sessionIdRef.current;
    const handle = setTimeout(() => persistDraft(text, sessionId), 300);
    return () => clearTimeout(handle);
  }, [text]);

  // The debounce alone can lose the last keystrokes when the webview is hidden or replaced.
  useEffect(() => {
    const flush = () => persistDraft(draftRef.current, sessionIdRef.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  // Stash the outgoing draft and load the incoming one. Skip the initial mount: the text is
  // already initialised from getDraft above, and a rerun here would overwrite what the user typed.
  useEffect(() => {
    const previous = sessionIdRef.current;
    if (previous === props.sessionId) return;
    persistDraft(draftRef.current, previous);
    const next = getDraft(props.sessionId);
    sessionIdRef.current = props.sessionId;
    draftRef.current = next;
    setText(next);
    setMention(undefined);
    setHistoryIndex(null);
  }, [props.sessionId]);

  // The host restored drafts from workspaceState. Never overwrite text the user already typed.
  const hydratedToken = useRef(props.draftToken);
  useEffect(() => {
    if (hydratedToken.current === props.draftToken) return;
    hydratedToken.current = props.draftToken;
    if (draftRef.current) return;
    const next = getDraft(props.sessionId);
    draftRef.current = next;
    setText(next);
  }, [props.draftToken]);

  // A rollback returns the old prompt to the composer. The token is mandatory here: the user may
  // already have typed something, which the workspace-state hydration above must never overwrite.
  const restoredToken = useRef(props.restoredDraft?.token);
  useEffect(() => {
    const next = props.restoredDraft;
    if (!next || restoredToken.current === next.token) return;
    restoredToken.current = next.token;
    draftRef.current = next.text;
    setText(next.text);
    setMention(undefined);
    setHistoryIndex(null);
  }, [props.restoredDraft]);

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
  }, [mention?.kind, mention?.query]);

  const fileResults = mention?.kind === "file" && props.fileResults.query === mention.query ? props.fileResults.items : [];
  const mentionQuery = mention?.kind === "skill" ? mention.query.trim().toLowerCase() : "";
  const skillResults: SkillSuggestion[] = useMemo(
    () =>
      mention?.kind === "skill"
        ? props.skills
            .filter((skill) => `${skill.id} ${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(mentionQuery))
            .slice(0, 30)
        : [],
    [mention?.kind, mentionQuery, props.skills],
  );
  const commandResults: CommandSuggestion[] = useMemo(
    () =>
      mention?.kind === "skill"
        ? props.commands
            .filter((command) => `${command.name} ${command.description ?? ""}`.toLowerCase().includes(mentionQuery))
            .slice(0, 30)
        : [],
    [mention?.kind, mentionQuery, props.commands],
  );
  const promptResults: PromptDefinition[] = useMemo(
    () =>
      mention?.kind === "skill"
        ? props.prompts
            .filter((p) => `${p.id} ${p.title} ${p.description}`.toLowerCase().includes(mention.query.trim().toLowerCase()))
            .slice(0, 12)
        : [],
    [mention?.kind, mention?.query, props.prompts],
  );
  const results: MentionItem[] = [
    ...promptResults.map((item): MentionItem => ({ kind: "prompt", item })),
    ...commandResults.map((item): MentionItem => ({ kind: "command", item })),
    ...skillResults.map((item): MentionItem => ({ kind: "skill", item })),
    ...fileResults.map((item): MentionItem => ({ kind: "file", item })),
  ];
  useEffect(() => setActive(0), [results.length, mention?.query]);
  // `active` is reset in an effect, so it can briefly point past a freshly shortened `results`.
  const activeIndex = results.length > 0 ? Math.min(active, results.length - 1) : 0;

  // Only known tokens get the link-like highlight; a typo such as `/nope` stays plain text.
  const commandNames = useMemo(
    () => new Set([...props.commands.map((c) => c.name), ...props.skills.map((s) => s.id)]),
    [props.commands, props.skills],
  );
  const tokenRanges = useMemo(() => {
    const commands = commandTokenRanges(text, commandNames).map((r) => ({ ...r, kind: "command" as const }));
    if (!props.variablesActive) return commands;
    const variables = promptVariableRanges(text).map((r) => ({ ...r, kind: "variable" as const }));
    return [...commands, ...variables].sort((a, b) => a.start - b.start);
  }, [text, commandNames, props.variablesActive]);

  // Keep the highlighted row inside the scrollable popup when walking a long list with the keys.
  useLayoutEffect(() => {
    const list = document.getElementById("mention-list");
    if (!list || results.length === 0) return;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, results.length, mention?.kind]);

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
    // Skills and slash commands stay in the text as `/skill` / `/command` (a skill is rewritten to
    // `@skill` when the prompt is sent). Files are attached as chips and sent separately as `files`,
    // so drop the `@query` instead of leaving it in the input.
    const label = item.kind === "command" ? `/${item.item.name} ` : item.kind === "skill" ? `/${item.item.id} ` : "";
    const next = text.slice(0, mention.start) + label + text.slice(caret);
    setText(next);
    setMention(undefined);
    if (item.kind === "file") props.onAddAttachment(item.item);
    if (item.kind === "prompt") post({ type: "usePrompt", id: item.item.id });
    requestAnimationFrame(() => {
      const pos = mention.start + label.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /** Replace the input with a remembered prompt and leave the caret at the end. */
  const recall = (index: number | null, value: string) => {
    setHistoryIndex(index);
    setText(value);
    requestAnimationFrame(() => {
      const end = value.length;
      ref.current?.setSelectionRange(end, end);
    });
  };

  const send = (explicit?: "steer") => {
    const value = text.trim();
    if (!value || props.disabled) return;
    // While the agent is working, plain Enter queues the message; Ctrl/Cmd+Enter steers it.
    const delivery = explicit ?? (props.busy ? "queue" : undefined);
    props.onSend(value, delivery);
    setText("");
    // Clear immediately so a pending pagehide cannot restore the just-sent draft.
    persistDraft("", sessionIdRef.current);
    draftRef.current = "";
    setMention(undefined);
    setHistoryIndex(null);
    historyDraft.current = "";
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
        const chosen = results[activeIndex];
        if (chosen) pick(chosen);
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
    // Shell-style prompt history: Up recalls the last prompt and older ones, Down walks forward
    // and finally restores whatever the user was typing. Mention suggestions keep their own keys.
    // Only bare Up/Down recall prompts: Cmd/Ctrl/Alt+Up are standard caret-movement shortcuts.
    if (!mention && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !composing.current && !e.isComposing) {
      if (e.key === "ArrowUp" && props.promptHistory.length > 0) {
        e.preventDefault();
        if (historyIndex === null) {
          historyDraft.current = text;
          const last = props.promptHistory.length - 1;
          recall(last, props.promptHistory[last]);
        } else if (historyIndex > 0) {
          recall(historyIndex - 1, props.promptHistory[historyIndex - 1]);
        }
        return;
      }
      if (e.key === "ArrowDown" && historyIndex !== null) {
        e.preventDefault();
        const next = historyIndex + 1;
        if (next < props.promptHistory.length) recall(next, props.promptHistory[next]);
        else recall(null, historyDraft.current);
        return;
      }
    }
    const action = composerAction(e, composing.current);
    if (action === "send" || action === "steer") {
      e.preventDefault();
      send(action === "steer" ? "steer" : undefined);
    }
  };

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
  // build/plan are already offered by the mode picker; show the agent dropdown only for extras.
  const hasExtraAgents = props.agents.some((a) => a.id !== "build" && a.id !== "plan");
  const listId = "mention-list";

  // The overlay mirrors the textarea's wrapping but paints only the command tokens, so the caret,
  // text selection and IME composition of the real input are never touched.
  const highlightNodes = (): VNode[] => {
    const nodes: VNode[] = [];
    let cursor = 0;
    tokenRanges.forEach((r, i) => {
      nodes.push(<span key={`before-${i}`}>{text.slice(cursor, r.start)}</span>);
      nodes.push(
        <span class={r.kind === "variable" ? "variable-token" : "command-token"} key={`token-${i}`}>
          {text.slice(r.start, r.end)}
        </span>,
      );
      cursor = r.end;
    });
    nodes.push(<span key="rest">{text.slice(cursor)}</span>);
    // A trailing newline keeps the last visual line wrapped exactly like the textarea does.
    nodes.push(<span key="eol">{"\n"}</span>);
    return nodes;
  };

  return (
    <div class="composer">
      <div class="composer-box">
        <Chips
          context={props.context}
          attachments={props.attachments}
          selectedContext={props.selectedContext}
          onToggleContext={props.onToggleContext}
          onRemoveAttachment={props.onRemoveAttachment}
        />
        <div class="input-wrap">
          <div class="input-highlight" ref={highlightRef} aria-hidden="true">
            {highlightNodes()}
          </div>
          {mention && <MentionPopup results={results} active={active} onPick={pick} listId={listId} />}
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
            aria-activedescendant={mention && results.length > 0 ? `mention-${activeIndex}` : undefined}
            disabled={props.disabled}
            onFocus={cancelBlurClose}
            onScroll={() => {
              const hl = highlightRef.current;
              if (hl && ref.current) hl.scrollTop = ref.current.scrollTop;
            }}
            onInput={(e) => {
              cancelBlurClose();
              const el = e.currentTarget as HTMLTextAreaElement;
              setText(el.value);
              // Editing a recalled prompt starts a fresh draft; a new Up begins from the latest one.
              if (historyIndex !== null) setHistoryIndex(null);
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
            onPaste={(e) => {
              const clipboard = e.clipboardData as DragData | null;
              if (!clipboard || !hasFiles(clipboard)) return; // Plain text keeps the browser's default paste.
              e.preventDefault();
              void collectPastedFiles(clipboard, readFileAsBase64).then((files) => {
                if (files.length > 0) post({ type: "dropFiles", files });
              });
            }}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              // WebKit fires compositionend before the Enter keydown that confirms the IME candidate.
              setTimeout(() => (composing.current = false), 0);
              const el = e.currentTarget as HTMLTextAreaElement;
              updateMention(el.value, el.selectionStart);
            }}
            onBlur={() => {
              cancelBlurClose();
              blurTimer.current = setTimeout(() => {
                blurTimer.current = undefined;
                // A mention opened after a quick focus round-trip must not be closed by this timer.
                if (document.activeElement !== ref.current) setMention(undefined);
              }, 150);
            }}
          />
        </div>
        <Toolbar
          selectedAgent={props.selectedAgent}
          selectedModel={props.selectedModel}
          agents={props.agents}
          models={props.models}
          busy={props.busy}
          disabled={props.disabled}
          hasExtraAgents={hasExtraAgents}
          modelItems={modelItems}
          modelKey={modelKey}
          currentModel={currentModel}
          text={text}
          modelPickerToken={props.modelPickerToken}
          onModelSelected={props.onModelSelected}
          onSend={send}
        />
      </div>
      <StatusBar
        busy={props.busy}
        waitingShell={props.waitingShell}
        disabled={props.disabled}
        text={text}
        autoApprove={props.autoApprove}
        onToggleAutoApprove={props.onToggleAutoApprove}
        canActOnSession={props.canActOnSession}
        contextTokens={props.contextTokens}
        contextEstimated={props.contextEstimated}
        cost={props.cost}
        currentModel={currentModel}
      />
    </div>
  );
}
