import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FormField, FormRequest, FormValue, PermissionRequest } from "../shared/api";
import type { ChatState } from "../shared/chatReducer";
import type { ExternalAttentionItem } from "../shared/protocol";
import type { SubagentState } from "../shared/subagents";
import { isImeKey } from "../shared/keys";
import { useT } from "./i18n";
import { IconChevron, IconWarning } from "./icons";
import { buildFormAnswer, initialValue, PermissionCard, QuestionCard } from "./messages";
import { clearReplyFailure } from "./replyFeedback";
import { post } from "./vscode";

interface AttentionBase {
  id: string;
  requestId: string;
  index: number;
  /** Set when the request came from a subagent, so the card says who is waiting. */
  sourceLabel?: string;
}

type AttentionItem =
  | (AttentionBase & { kind: "permission"; permission: PermissionRequest })
  | (AttentionBase & { kind: "question"; form: FormRequest; field?: FormField; last: boolean });

type Answers = Record<string, FormValue | undefined>;

function initialAnswers(form: FormRequest): Answers {
  return Object.fromEntries(form.fields.map((f) => [f.key, initialValue(f)]));
}

/**
 * Pending approvals and questions, docked just above the composer.
 *
 * The same request can be attached to a tool hidden inside a folded step, so rendering it inline
 * makes it easy to miss. Here every request that needs the user is collected in one place and shown
 * one at a time: the newest one takes the spotlight, older ones are reachable with the
 * previous/next buttons. A question tool can bundle several questions in a single server-side
 * form; each visible field becomes its own entry and the answers are collected before the one
 * `formReply` is posted. The cards themselves still own the reply protocol.
 */
export function AttentionOverlay({
  state,
  subagents,
  external,
}: {
  state: ChatState;
  subagents?: SubagentState;
  external?: ExternalAttentionItem[];
}) {
  const t = useT();
  const subagentLabel = t("subagent");
  const otherLabel = t("otherSession");
  const items = useMemo<AttentionItem[]>(() => {
    const out: AttentionItem[] = [];
    const seen = new Set<string>();
    const pushForm = (f: FormRequest, sourceLabel?: string) => {
      if (seen.has(f.id)) return;
      seen.add(f.id);
      const visible = f.fields.filter((field) => !field.hidden);
      // A form whose fields are all hidden still needs a card so it can be submitted or cancelled.
      const fields = visible.length > 0 ? visible : [undefined];
      fields.forEach((field, index) =>
        out.push({
          id: `${f.id}:${index}`,
          requestId: f.id,
          index,
          kind: "question",
          form: f,
          field,
          last: index === fields.length - 1,
          sourceLabel,
        }),
      );
    };
    const collect = (chat: ChatState, sourceLabel?: string) => {
      for (const p of chat.permissions) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ id: p.id, requestId: p.id, index: 0, kind: "permission", permission: p, sourceLabel });
      }
      for (const f of chat.forms) pushForm(f, sourceLabel);
    };
    collect(state);
    // Subagents are headless: their `ask` requests would otherwise have no card to answer and the
    // child turn would hang forever. The reply itself uses `request.sessionID`, so it reaches the
    // child session even though the card is shown here, in the parent chat.
    for (const id of subagents?.order ?? []) {
      const child = subagents?.byId[id];
      if (!child || (child.permissions.length === 0 && child.forms.length === 0)) continue;
      const name = subagents?.meta[id]?.title || subagents?.meta[id]?.agent;
      collect(child, name ? `${subagentLabel}: ${name}` : subagentLabel);
    }
    // A turn started in the TUI (or another client on the same server) has no view here, but its
    // request still belongs to the user. The card replies to the request's own session id.
    for (const item of external ?? []) {
      const sourceLabel = item.label ? `${otherLabel}: ${item.label}` : otherLabel;
      if (item.permission) {
        const p = item.permission;
        if (!seen.has(p.id)) {
          seen.add(p.id);
          out.push({ id: p.id, requestId: p.id, index: 0, kind: "permission", permission: p, sourceLabel });
        }
      }
      if (item.question) pushForm(item.question, sourceLabel);
    }
    return out;
  }, [state.permissions, state.forms, subagents, external, subagentLabel, otherLabel]);

  // One entry per form, including the ones that came from subagents. Field cards share a form id.
  const allForms = useMemo<FormRequest[]>(() => {
    const byId = new Map<string, FormRequest>();
    for (const item of items) if (item.kind === "question") byId.set(item.form.id, item.form);
    return [...byId.values()];
  }, [items]);

  // Live events append requests and a resync re-posts the same objects. Keep the arrival order by
  // request id so a new request becomes current even when another one is already pending.
  const requestIds = useMemo(() => [...new Set(items.map((i) => i.requestId))], [items]);
  const signature = requestIds.join("\u0001");
  const [order, setOrder] = useState<string[]>(() => requestIds);
  useEffect(() => {
    const ids = signature === "" ? [] : signature.split("\u0001");
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, [signature]);

  // Newest request first, but the questions of one form stay in the order the tool asked them.
  const ordered = useMemo(() => {
    const groups = new Map<string, AttentionItem[]>();
    for (const item of items) {
      const group = groups.get(item.requestId) ?? [];
      group.push(item);
      groups.set(item.requestId, group);
    }
    return [...order].reverse().flatMap((id) => (groups.get(id) ?? []).sort((a, b) => a.index - b.index));
  }, [items, order]);

  const sectionRef = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const shownRequests = useRef<string[]>([]);
  useEffect(() => {
    const ids = [...new Set(ordered.map((i) => i.requestId))];
    const added = ids.some((id) => !shownRequests.current.includes(id));
    shownRequests.current = ids;
    // A new request takes the spotlight; answering one just shifts the queue.
    setIndex((prev) => (added ? 0 : Math.min(prev, Math.max(0, ordered.length - 1))));
  }, [ordered]);

  // Keyboard users should land on the request instead of tabbing through the whole transcript while
  // the turn is blocked. Focus moves only when a *new* card takes the spotlight (or after answering
  // one), never on every streamed token that re-renders the same card.
  const activeIndex = ordered.length > 0 ? Math.min(index, ordered.length - 1) : -1;
  const active = ordered[activeIndex];
  useEffect(() => {
    if (active?.id) sectionRef.current?.focus();
  }, [active?.id]);

  // 1/2/3 also work when focus is on the overlay container (not on the card itself). The card's own
  // handler stops propagation for its shortcuts, so this listener cannot double-reply.
  const activePermission = active?.kind === "permission" ? active.permission : undefined;
  useEffect(() => {
    if (!activePermission) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isImeKey(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, input, a, textarea, select")) return;
      const hasAlways = (activePermission.save?.length ?? 0) > 0;
      const decision = e.key === "1" ? "once" : e.key === "2" && hasAlways ? "always" : e.key === "3" ? "reject" : undefined;
      if (!decision) return;
      e.preventDefault();
      post({
        type: "permissionReply",
        sessionId: activePermission.sessionID,
        requestId: activePermission.id,
        decision,
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePermission]);

  // Answers belong to the form, not to the field card: navigating between questions must not lose
  // them, and a single reply carries every field (including hidden ones with their defaults).
  const [answers, setAnswers] = useState<Record<string, Answers>>(() => Object.fromEntries(allForms.map((f) => [f.id, initialAnswers(f)])));
  const [customs, setCustoms] = useState<Record<string, Record<string, string>>>({});
  const [busyForms, setBusyForms] = useState<Record<string, boolean>>({});
  const seenForms = useRef(new Map(allForms.map((f) => [f.id, f])));
  useEffect(() => {
    const ids = new Set(allForms.map((f) => f.id));
    setAnswers((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const f of allForms) {
        if (prev[f.id]) next[f.id] = prev[f.id];
        else {
          next[f.id] = initialAnswers(f);
          changed = true;
        }
      }
      for (const id of Object.keys(prev)) if (!ids.has(id)) changed = true;
      return changed ? next : prev;
    });
    setCustoms((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const id of ids) {
        if (prev[id]) next[id] = prev[id];
        else {
          next[id] = {};
          changed = true;
        }
      }
      for (const id of Object.keys(prev)) if (!ids.has(id)) changed = true;
      return changed ? next : prev;
    });
    // A resync re-posts the same pending form as a fresh object: re-enable its buttons.
    const resets: string[] = [];
    for (const f of allForms) {
      if (seenForms.current.get(f.id) !== f) resets.push(f.id);
      seenForms.current.set(f.id, f);
    }
    for (const id of [...seenForms.current.keys()]) if (!ids.has(id)) seenForms.current.delete(id);
    if (resets.length > 0) {
      setBusyForms((prev) => ({ ...prev, ...Object.fromEntries(resets.map((id) => [id, false])) }));
    }
  }, [allForms]);

  const setAnswer = (formId: string, key: string, value: FormValue | undefined) =>
    setAnswers((prev) => ({ ...prev, [formId]: { ...(prev[formId] ?? {}), [key]: value } }));
  const setCustom = (formId: string, key: string, value: string) =>
    setCustoms((prev) => ({ ...prev, [formId]: { ...(prev[formId] ?? {}), [key]: value } }));
  const submitForm = (form: FormRequest) => {
    clearReplyFailure({ kind: "form", id: form.id });
    setBusyForms((prev) => ({ ...prev, [form.id]: true }));
    post({
      type: "formReply",
      sessionId: form.sessionID,
      formId: form.id,
      answer: buildFormAnswer(form, answers[form.id] ?? {}, customs[form.id] ?? {}),
    });
  };
  const cancelForm = (form: FormRequest) => {
    clearReplyFailure({ kind: "form", id: form.id });
    setBusyForms((prev) => ({ ...prev, [form.id]: true }));
    post({ type: "formCancel", sessionId: form.sessionID, formId: form.id });
  };

  if (ordered.length === 0) return null;
  const currentIndex = activeIndex;
  const current = active!;
  return (
    <section ref={sectionRef} tabIndex={-1} class="attention-overlay" role="group" aria-label={t("needsInput")}>
      <div class="attention-head">
        <IconWarning />
        <span class="attention-title">{t("needsInput")}</span>
        {current.sourceLabel && <span class="attention-source">{current.sourceLabel}</span>}
        <span class="attention-count" aria-live="polite">
          {t("attentionCount", currentIndex + 1, ordered.length)}
        </span>
        {ordered.length > 1 && (
          <span class="attention-nav">
            <button
              type="button"
              class="icon-button attention-prev"
              aria-label={t("attentionPrevious")}
              disabled={currentIndex === ordered.length - 1}
              onClick={() => setIndex(currentIndex + 1)}
            >
              <IconChevron />
            </button>
            <button
              type="button"
              class="icon-button attention-next"
              aria-label={t("attentionNext")}
              disabled={currentIndex === 0}
              onClick={() => setIndex(currentIndex - 1)}
            >
              <IconChevron />
            </button>
          </span>
        )}
      </div>
      <div class="attention-body">
        {current.kind === "permission" ? (
          <PermissionCard key={current.id} request={current.permission} />
        ) : (
          <QuestionCard
            key={current.id}
            form={current.form}
            field={current.field}
            value={answers[current.form.id]?.[current.field?.key ?? ""]}
            custom={customs[current.form.id]?.[current.field?.key ?? ""] ?? ""}
            busy={busyForms[current.form.id] ?? false}
            last={current.last}
            onChange={(value) => current.field && setAnswer(current.form.id, current.field.key, value)}
            onCustom={(value) => current.field && setCustom(current.form.id, current.field.key, value)}
            onNext={() => setIndex(currentIndex + 1)}
            onSubmit={() => submitForm(current.form)}
            onCancel={() => cancelForm(current.form)}
          />
        )}
      </div>
    </section>
  );
}
