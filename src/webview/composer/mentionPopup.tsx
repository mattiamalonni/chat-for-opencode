import { FileTypeIcon } from "../fileIcons";
import { useT } from "../i18n";
import { IconTool } from "../icons";
import type { MentionItem } from "./mention";

export function MentionPopup(props: { results: MentionItem[]; active: number; onPick: (item: MentionItem) => void; listId: string }) {
  const { results, active, listId } = props;
  const pick = props.onPick;
  const t = useT();
  return (
    <ul class="mention-popup" role="listbox" id={listId} aria-label={t("suggestions")}>
      {results.length === 0 ? (
        <li class="mention-empty" role="option" aria-disabled="true" aria-selected="false">
          {t("noFilesOrSkillsFound")}
        </li>
      ) : (
        results.map((r, i) => (
          <li
            key={
              r.kind === "file"
                ? r.item.uri
                : r.kind === "command"
                  ? `command:${r.item.name}`
                  : r.kind === "prompt"
                    ? `prompt:${r.item.id}`
                    : `skill:${r.item.id}`
            }
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
            <span class="mention-name">{r.kind === "prompt" ? r.item.title : r.item.name}</span>
            <span class="mention-path">
              {r.kind === "file"
                ? r.item.detail
                : r.kind === "prompt"
                  ? `/${r.item.id} · ${r.item.description}`
                  : r.kind === "command"
                    ? `/${r.item.name}${r.item.description ? ` · ${r.item.description}` : ""}`
                    : `@${r.item.id}${r.item.description ? ` · ${r.item.description}` : ""}`}
            </span>
          </li>
        ))
      )}
    </ul>
  );
}
