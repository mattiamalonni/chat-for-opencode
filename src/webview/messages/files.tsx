import { type ChangedFile } from "../../shared/chatReducer";

import { FileTypeIcon } from "../fileIcons";
import { useT } from "../i18n";

import { post } from "../vscode";

export function FileList({ files, applied }: { files: ChangedFile[]; applied: boolean }) {
  const t = useT();
  return (
    <ul class="file-list">
      {files.map((f) => {
        const { name, dir } = splitFilePath(f.file);
        const label = (
          <span class="file-name">
            <span class="file-base">{name}</span>
            {dir && <span class="file-path">{dir}</span>}
          </span>
        );
        return (
          <li key={f.file} class="file-item">
            {f.patch ? (
              <button
                type="button"
                class="file-row"
                title={`${t("openDiff")}: ${f.file}`}
                onClick={() => post({ type: "openDiff", file: f.file, patch: f.patch, applied })}
              >
                <FileTypeIcon path={f.file} />
                {label}
                <span class="adds">+{f.additions}</span>
                <span class="dels">-{f.deletions}</span>
              </button>
            ) : (
              <span class="file-row" title={t("noDiffAvailable")}>
                <FileTypeIcon path={f.file} />
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

import { splitFilePath } from "./text";
