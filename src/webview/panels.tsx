import type { FileDiff, InboxItem } from "../shared/api";

import { useT } from "./i18n";
import { IconCheck, IconChevron, IconClose, IconEdit, IconRefresh, IconSend } from "./icons";

import { FileList } from "./messages";
import { post } from "./vscode";

/** Prompts the server has accepted but not delivered yet, with actions mirroring the API. */
export function InboxPanel(props: {
  items: InboxItem[];
  onSendNow: (item: InboxItem) => void;
  onEdit: (item: InboxItem) => void;
  onRemove: (item: InboxItem) => void;
}) {
  const t = useT();
  return (
    <details class="panel inbox" open>
      <summary>
        <IconChevron class="chevron" />
        {t("inbox")} ({props.items.length})
      </summary>
      <ul>
        {props.items.map((item) => {
          const text = item.type === "user" ? (item.payload.text ?? "") : (item.payload.description ?? item.payload.text ?? item.type);
          const editable = item.type === "user" && typeof item.payload.text === "string";
          return (
            <li class="inbox-item" key={item.id}>
              <span class="inbox-text" title={text}>
                {text}
              </span>
              {item.delivery === "queue" && <span class="inbox-delivery">{t("inboxDeliveryQueue")}</span>}
              <span class="inbox-actions">
                {item.delivery === "queue" && (
                  <button
                    type="button"
                    class="icon-button tooltip-host"
                    data-tooltip={t("inboxSendNow")}
                    aria-label={t("inboxSendNow")}
                    onClick={() => props.onSendNow(item)}
                  >
                    <IconSend />
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    class="icon-button tooltip-host"
                    data-tooltip={t("inboxEdit")}
                    aria-label={t("inboxEdit")}
                    onClick={() => props.onEdit(item)}
                  >
                    <IconEdit />
                  </button>
                )}
                <button
                  type="button"
                  class="icon-button tooltip-host"
                  data-tooltip={t("inboxRemove")}
                  aria-label={t("inboxRemove")}
                  onClick={() => props.onRemove(item)}
                >
                  <IconClose />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function TodoPanel({ todos }: { todos: { content: string; status: string }[] }) {
  const t = useT();
  const done = todos.filter((x) => x.status === "completed").length;
  return (
    <details class="panel todos" open>
      <summary>
        <IconChevron class="chevron" />
        {t("todos")} ({done}/{todos.length})
      </summary>
      <ul>
        {todos.map((todo, i) => (
          <li key={i} class={`todo ${todo.status}`}>
            <span class="todo-box" aria-hidden="true">
              {todo.status === "completed" ? <IconCheck /> : todo.status === "in_progress" ? "◐" : ""}
            </span>
            <span class="sr-only">{todo.status}</span>
            <span>{todo.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ChangesPanel({ files, onDismiss }: { files: FileDiff[]; onDismiss: () => void }) {
  const t = useT();
  const additions = files.reduce((n, f) => n + (Number(f.additions) || 0), 0);
  const deletions = files.reduce((n, f) => n + (Number(f.deletions) || 0), 0);
  return (
    // `<summary>` stays the only child of `<details>` that toggles it: nesting buttons inside a
    // summary gives them unreliable keyboard/screen-reader semantics. The action row is a sibling.
    <div class="changes-panel">
      {/* Start collapsed: the user decides when to look at the edits, and the
          DOM keeps their choice across re-renders (no controlled `open` prop). */}
      <details class="panel changes">
        <summary>
          <IconChevron class="chevron" />
          {files.length === 1 ? t("changedFile", files.length) : t("changedFiles", files.length)}
        </summary>
        <FileList files={files} applied />
      </details>
      <div class="changes-actions">
        <button
          type="button"
          class="icon-button view-all-changes"
          aria-label={t("viewAllChanges")}
          data-tooltip={t("viewAllChanges")}
          onClick={() =>
            post({
              type: "openDiffs",
              files: files.filter((f) => f.patch).map((f) => ({ file: f.file, patch: f.patch })),
            })
          }
        >
          <span class="adds">+{additions}</span>
          {additions > 0 && deletions > 0 ? " " : ""}
          {deletions > 0 && <span class="dels">-{deletions}</span>}
        </button>
        <button
          type="button"
          class="icon-button tooltip-host refresh-changes"
          data-tooltip={t("refresh")}
          aria-label={t("refresh")}
          onClick={() => post({ type: "refreshChanges" })}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          class="icon-button tooltip-host dismiss-changes"
          data-tooltip={t("dismissChanges")}
          aria-label={t("dismissChanges")}
          onClick={onDismiss}
        >
          <IconCheck />
        </button>
      </div>
    </div>
  );
}
