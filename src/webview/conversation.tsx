import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ModelInfo } from "../shared/api";
import { chatReducer } from "../shared/chatReducer";

import type { ConnectionStatus, UiError } from "../shared/protocol";

import { useT } from "./i18n";
import { IconChevron, IconWarning } from "./icons";
import { fileRefToPath } from "../shared/fileRef";

import { AssistantStatus, MessageView, ToolCard, ToolGroup, TurnStatsRow } from "./messages";
import { post } from "./vscode";

export function Conversation({
  chat,
  models,
  status,
  error,
  hasActiveFile,
  hasSelection,
  scrollToken,
  searchQuery,
  label,
  revealMessageId,
  onRevealed,
  onSuggestedPrompt,
}: {
  chat: ReturnType<typeof chatReducer>;
  models: ModelInfo[];
  status?: ConnectionStatus;
  error?: UiError;
  hasActiveFile?: boolean;
  hasSelection?: boolean;
  scrollToken: number;
  searchQuery: string;
  label?: string;
  revealMessageId?: string;
  onRevealed?: () => void;
  onSuggestedPrompt?: (text: string) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = useRef<string | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const items = useMemo(() => conversationItems(chat.messages, chat.turns), [chat.messages, chat.turns]);
  const query = searchQuery.trim().toLowerCase();

  // Fold state is owned here so one control can expand/collapse every step of a turn. Defaults
  // come from the items themselves (latest finished turn open, older turns folded, search open).
  const [stepOverrides, setStepOverrides] = useState<Map<string, boolean>>(new Map());
  useEffect(() => setStepOverrides(new Map()), [chat.sessionId]);
  const stepGroups = useMemo(() => {
    const groups: StepGroup[] = [];
    let current: StepGroup | undefined;
    for (const item of items) {
      if (item.kind === "step") {
        if (!current) {
          current = { keys: [], defaults: new Map() };
          groups.push(current);
        }
        current.keys.push(item.key);
        current.defaults.set(item.key, item.live || !!query);
      } else if (item.kind === "turnStats" || item.kind === "message") {
        current = undefined;
      }
    }
    return groups;
  }, [items, query]);
  const groupByKey = useMemo(() => {
    const map = new Map<string, StepGroup>();
    for (const group of stepGroups) for (const key of group.keys) map.set(key, group);
    return map;
  }, [stepGroups]);
  const stepControl: StepControl = {
    expanded: (key, fallback) => stepOverrides.get(key) ?? fallback,
    toggle: (key, fallback) =>
      setStepOverrides((prev) => {
        const next = new Map(prev);
        next.set(key, !(prev.get(key) ?? fallback));
        return next;
      }),
    toggleGroup: (group) =>
      setStepOverrides((prev) => {
        const open = group.keys.every((key) => prev.get(key) ?? group.defaults.get(key) ?? false);
        const next = new Map(prev);
        for (const key of group.keys) next.set(key, !open);
        return next;
      }),
  };

  const scrollToEnd = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  };

  // A new prompt always brings the conversation back to the latest message, even if the user had
  // scrolled up. Without this, the reply streams in off-screen and the chat appears frozen.
  useEffect(() => {
    const last = chat.messages.at(-1);
    if (last && last.id !== lastId.current && last.kind === "user") scrollToEnd();
    lastId.current = last?.id;
  }, [chat.messages]);

  useEffect(() => {
    lastId.current = undefined;
    scrollToEnd();
  }, [chat.sessionId]);

  useEffect(() => {
    scrollToEnd();
  }, [scrollToken]);

  // A reveal is a one-shot command, not persistent state. Previously the id stayed set, so every
  // streamed token re-ran this effect, scrolled the user back to the old hit and fought auto-scroll.
  const consumedReveal = useRef<string | undefined>(undefined);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!revealMessageId) {
      consumedReveal.current = undefined;
      return;
    }
    if (consumedReveal.current === revealMessageId) return;
    const container = ref.current;
    if (!container) return;
    // Compare `dataset` instead of interpolating the id into a CSS selector: message ids come from
    // the server, so quotes/brackets in one would throw a SyntaxError and take down the webview.
    const el = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (candidate) => candidate.dataset.messageId === revealMessageId,
    );
    if (!el) return; // Not rendered yet (e.g. still loading): retry when messages change.
    consumedReveal.current = revealMessageId;
    // Scroll only the chat container: `scrollIntoView` would also scroll the surrounding webview
    // (and the editor), which can leave the visible chat apparently stuck somewhere else.
    const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += delta - container.clientHeight / 2 + el.clientHeight / 2;
    stick.current = false;
    setAtBottom(false);
    el.classList.add("revealed");
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => el.classList.remove("revealed"), 1600);
    onRevealed?.();
  }, [revealMessageId, chat.messages, onRevealed]);

  // Pin to the bottom only when the conversation actually grows (a streamed token, a new
  // message, a new card). It runs only on identity changes, so an unrelated state change
  // (tooltip direction, context chips, session refresh) yanked the view back
  // down while the user was scrolling up through old history — the chat felt stuck to the
  // bottom. Comparing scroll heights also avoids fighting the user when content is replaced
  // rather than appended (e.g. steps folding into a summary).
  const lastScrollHeight = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = lastScrollHeight.current;
    lastScrollHeight.current = el.scrollHeight;
    if (el.scrollHeight > previous && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.permissions, chat.forms, chat.retry, chat.busy, items.length]);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const apply = target.closest("[data-action='apply-code']");
    if (apply) {
      const block = apply.closest(".code-block");
      const code = block?.querySelector("code")?.textContent ?? "";
      // The nearest file reference in the same reply is the best guess for the target. The host
      // validates it against the workspace and falls back to a picker when it is absent or stale.
      const message = apply.closest(".msg");
      const refs = Array.from(message?.querySelectorAll<HTMLElement>("[data-file]") ?? []);
      const preceding = refs.filter((el) => !!(apply.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)).at(-1);
      const path = preceding?.dataset.file ? fileRefToPath(preceding.dataset.file) : undefined;
      post({ type: "applyCode", text: code, ...(path ? { path } : {}) });
      apply.textContent = t("applyCodeTitle");
      setTimeout(() => (apply.textContent = t("applyCode")), 1200);
      return;
    }
    const copy = target.closest("[data-action='copy-code']");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      post({ type: "copy", text: code });
      copy.textContent = t("copied");
      setTimeout(() => (copy.textContent = t("copy")), 1200);
      return;
    }
    // File references linkified in prose carry a data-file attribute; host `openFile`
    // resolves the path against the folder and places the cursor at the right line.
    const fileLink = target.closest<HTMLElement>("[data-file]");
    if (fileLink) {
      e.preventDefault();
      post({ type: "openFile", path: fileLink.dataset.file ?? "" });
      return;
    }
    const link = target.closest("a[href]");
    if (link) {
      e.preventDefault();
      post({ type: "openLink", href: link.getAttribute("href") ?? "" });
    }
  };
  const renderItem = (item: ConversationItem, q: string) => {
    const filteredOut = !!q && !itemSearchText(item).toLowerCase().includes(q);
    switch (item.kind) {
      case "tools":
        return <ToolGroup key={item.key} parts={item.parts} state={chat} filteredOut={filteredOut} searchQuery={q} />;
      case "tool":
        return <ToolCard key={item.key} part={item.part} state={chat} filteredOut={filteredOut} searchQuery={q} />;
      case "assistant":
        return (
          <MessageView
            key={item.key}
            message={{ ...item.message, parts: item.parts }}
            state={chat}
            grouped={item.grouped}
            showStatus={false}
            filteredOut={filteredOut}
            searchQuery={q}
          />
        );
      case "status":
        return <AssistantStatus key={item.key} message={item.message} typing={item.typing} filteredOut={filteredOut} />;
      case "step":
        return (
          <StepBlock
            key={item.key}
            index={item.index}
            lastIndex={item.lastIndex}
            details={item.details}
            live={item.live}
            controlKey={item.key}
            group={groupByKey.get(item.key)}
            filteredOut={filteredOut}
            searchActive={!!q}
            render={renderItem}
          />
        );
      case "turnStats":
        return <TurnStatsRow key={item.key} stats={item.stats} models={models} />;
      case "message":
        return (
          <MessageView
            key={item.message.id}
            message={item.message}
            state={chat}
            grouped={false}
            filteredOut={filteredOut}
            searchQuery={q}
          />
        );
    }
  };
  return (
    <StepControlContext.Provider value={stepControl}>
      <div class="conversation-wrap">
        <div
          class="conversation"
          ref={ref}
          role="log"
          aria-label={label ?? t("appName")}
          aria-busy={chat.busy}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget as HTMLDivElement;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            stick.current = bottom;
            setAtBottom((prev) => (prev === bottom ? prev : bottom));
          }}
          onClick={onClick}
        >
          {chat.messages.length === 0 &&
            (error && SETUP_ERROR_KINDS.has(error.kind) ? (
              <SetupWelcome error={error} />
            ) : (
              <div class="welcome">
                <h2>{t("welcomeTitle")}</h2>
                <p>{t("welcomeBody")}</p>
                {(status === "error" || status === "reconnecting") && <p class="welcome-hint">{t("setupHint")}</p>}
                {onSuggestedPrompt && (
                  <>
                    <p class="welcome-hint">{t("welcomeHint")}</p>
                    <div class="welcome-starters" aria-label={t("welcomeStarters")}>
                      <span class="welcome-starters-label">{t("welcomeStarters")}</span>
                      {[
                        { text: t("starterExplain"), enabled: !!hasActiveFile },
                        { text: t("starterBugs"), enabled: !!hasSelection },
                        { text: t("starterTests"), enabled: !!hasActiveFile },
                        { text: t("starterPlan"), enabled: !!hasActiveFile },
                      ]
                        .filter((starter) => starter.enabled)
                        .map((starter) => (
                          <button type="button" class="welcome-starter" key={starter.text} onClick={() => onSuggestedPrompt(starter.text)}>
                            {starter.text}
                          </button>
                        ))}
                      {!hasActiveFile && !hasSelection && <p class="welcome-hint">{t("starterAvailabilityHint")}</p>}
                    </div>
                  </>
                )}
              </div>
            ))}
          {items.map((item) => renderItem(item, query))}
          {chat.busy && chat.messages.at(-1)?.kind !== "assistant" && (
            <div class="typing" aria-label={t("thinking")}>
              <span />
              <span />
              <span />
            </div>
          )}
          {chat.retry && (
            <div class="notice warning" role="status">
              <IconWarning />
              {t("retrying", chat.retry.attempt, chat.retry.message)}
            </div>
          )}
        </div>
        {!atBottom && chat.messages.length > 0 && (
          <button type="button" class="jump-latest" onClick={scrollToEnd}>
            <IconChevron />
            {t("jumpToLatest")}
          </button>
        )}
      </div>
    </StepControlContext.Provider>
  );
}

import { SetupWelcome } from "./banners";
import { conversationItems, itemSearchText } from "./conversationModel";
import { SETUP_ERROR_KINDS } from "./setupErrors";
import { StepBlock, StepControlContext } from "./stepFold";

import type { ConversationItem } from "./conversationModel";
import type { StepControl, StepGroup } from "./stepFold";
