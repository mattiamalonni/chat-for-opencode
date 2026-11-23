import type { Attachment, ContextItem } from "../../shared/protocol";
import { FileTypeIcon } from "../fileIcons";
import { useT } from "../i18n";
import { IconClose, IconPlus, IconSelection } from "../icons";
import { post } from "../vscode";

export function Chips(props: {
  context: ContextItem[];
  attachments: Attachment[];
  selectedContext: Set<string>;
  onToggleContext: (id: string) => void;
  onRemoveAttachment: (uri: string) => void;
}) {
  const t = useT();
  return (
    <>
      {(props.context.length > 0 || props.attachments.length > 0) && (
        <ul class="chips" aria-label={t("context")}>
          {props.context.map((c) => {
            const selected = props.selectedContext.has(c.id);
            return (
              <li class={`chip ${c.kind === "file" ? "implicit" : ""} ${selected ? "" : "off"}`} key={c.id} title={c.detail ?? c.uri}>
                {c.kind === "selection" ? <IconSelection /> : <FileTypeIcon path={c.label} />}
                <span>{c.label}</span>
                <span class="chip-kind">{c.kind === "file" ? t("currentFile") : t("selection")}</span>
                {selected ? (
                  <button
                    type="button"
                    class="chip-remove tooltip-host"
                    data-tooltip={`${t("removeContext")}: ${c.label}`}
                    aria-label={`${t("removeContext")}: ${c.label}`}
                    onClick={() => props.onToggleContext(c.id)}
                  >
                    <IconClose />
                  </button>
                ) : (
                  <button
                    type="button"
                    class="chip-add tooltip-host"
                    aria-label={`${t("addContext")}: ${c.label}`}
                    data-tooltip={`${t("addContext")}: ${c.label}`}
                    onClick={() => props.onToggleContext(c.id)}
                  >
                    <IconPlus />
                  </button>
                )}
              </li>
            );
          })}
          {props.attachments.map((a) => {
            const openable = a.uri.startsWith("file:");
            const open = () => {
              if (openable) post({ type: "openAttachment", uri: a.uri });
            };
            return (
              <li class="chip" key={a.uri} title={a.detail ?? a.uri}>
                <span
                  class="chip-open"
                  data-openable={openable ? "true" : "false"}
                  role={openable ? "button" : undefined}
                  tabIndex={openable ? 0 : undefined}
                  aria-label={openable ? `${t("openFile")}: ${a.name}` : undefined}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (openable && e.key === "Enter") {
                      e.preventDefault();
                      open();
                    }
                  }}
                >
                  {a.kind === "selection" ? <IconSelection /> : <FileTypeIcon path={a.name} />}
                  <span>{a.kind === "selection" ? (a.detail ?? a.name) : a.name}</span>
                </span>
                <button
                  type="button"
                  class="chip-remove tooltip-host"
                  data-tooltip={`${t("removeContext")}: ${a.name}`}
                  aria-label={`${t("removeContext")}: ${a.name}`}
                  onClick={() => props.onRemoveAttachment(a.uri)}
                >
                  <IconClose />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
