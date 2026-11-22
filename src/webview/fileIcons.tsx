import { type FunctionComponent, type SVGAttributes } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FileIconData, FileIconFont, HostMessage } from "../shared/protocol";
import {
  IconFile,
  IconFileCode,
  IconFileConfig,
  IconFileData,
  IconFileDoc,
  IconFileImage,
  IconFileJson,
  IconFileMarkdown,
  IconFileShell,
  IconFileStyle,
} from "./icons";
import { onHostMessage, post } from "./vscode";

type Icon = FunctionComponent<SVGAttributes<SVGSVGElement>>;

const CODE = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "kt",
  "kts",
  "scala",
  "lua",
  "vue",
  "svelte",
  "astro",
]);
const MARKDOWN = new Set(["md", "mdx", "markdown"]);
const JSON = new Set(["json", "jsonc", "json5"]);
const STYLE = new Set(["css", "scss", "sass", "less", "styl"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff"]);
const CONFIG = new Set(["yaml", "yml", "toml", "ini", "conf", "cfg", "env", "lock", "properties", "xml", "plist"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);
const DATA = new Set(["csv", "tsv", "sql", "db", "sqlite"]);
const DOC = new Set(["txt", "pdf", "rtf", "doc", "docx", "log"]);

function extensionOf(path: string | undefined): string {
  const file = (path ?? "").split(/[?#]/, 1)[0].split(/[\\/]/).pop() ?? "";
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

/** Fallback used in standalone mode and whenever the theme has no icon for a path. */
export function fileIcon(path: string | undefined): { Icon: Icon; className: string } {
  const ext = extensionOf(path);
  if (CODE.has(ext)) return { Icon: IconFileCode, className: "code" };
  if (MARKDOWN.has(ext)) return { Icon: IconFileMarkdown, className: "markdown" };
  if (JSON.has(ext)) return { Icon: IconFileJson, className: "json" };
  if (STYLE.has(ext)) return { Icon: IconFileStyle, className: "style" };
  if (IMAGE.has(ext)) return { Icon: IconFileImage, className: "image" };
  if (CONFIG.has(ext)) return { Icon: IconFileConfig, className: "config" };
  if (SHELL.has(ext)) return { Icon: IconFileShell, className: "shell" };
  if (DATA.has(ext)) return { Icon: IconFileData, className: "data" };
  if (DOC.has(ext)) return { Icon: IconFileDoc, className: "doc" };
  return { Icon: IconFile, className: "other" };
}

// --- icons from the user's VS Code file icon theme ------------------------------------------

const store = {
  icons: new Map<string, FileIconData | null>(),
  fonts: new Map<string, FileIconFont>(),
  /** Bumped on every host answer so rendered chips re-check their path. */
  version: 0,
};
const listeners = new Set<() => void>();
/** Last definition requested per id, plus its loaded face, so unchanged replies don't reload it. */
const addedFonts = new Map<string, { font: FileIconFont; face: FontFace }>();
const fontGen = new Map<string, number>();
let pending = new Set<string>();
let scheduled = false;

function notify(): void {
  store.version++;
  for (const listener of listeners) listener();
}

function sameFont(a: FileIconFont | undefined, b: FileIconFont): boolean {
  return !!a && a.family === b.family && a.src === b.src && a.format === b.format && a.weight === b.weight && a.style === b.style;
}

function registerFont(id: string, font: FileIconFont): void {
  if (typeof FontFace === "undefined" || !document.fonts) return;
  const current = addedFonts.get(id);
  if (sameFont(current?.font, font)) return;
  const generation = (fontGen.get(id) ?? 0) + 1;
  fontGen.set(id, generation);
  const face = new FontFace(font.family, `url("${font.src}")`, {
    weight: font.weight ?? "normal",
    style: font.style ?? "normal",
  });
  void face.load().then(
    () => {
      // Each icon reply carries all fonts; ignore a load that lost a race to a newer definition.
      if (fontGen.get(id) !== generation) return;
      if (current) document.fonts.delete(current.face);
      document.fonts.add(face);
      addedFonts.set(id, { font, face });
      notify();
    },
    () => undefined,
  );
}

function applyIcons(msg: Extract<HostMessage, { type: "fileIcons" }>): void {
  if (msg.reset) {
    store.icons.clear();
    store.fonts.clear();
    if (typeof FontFace !== "undefined" && document.fonts) {
      for (const { face } of addedFonts.values()) document.fonts.delete(face);
    }
    addedFonts.clear();
    fontGen.clear();
  }
  for (const [id, font] of Object.entries(msg.fonts)) {
    store.fonts.set(id, font);
    registerFont(id, font);
  }
  for (const [path, icon] of Object.entries(msg.icons)) store.icons.set(path, icon);
  notify();
}

onHostMessage((msg) => {
  if (msg.type === "fileIcons") applyIcons(msg);
});

function requestIcon(path: string): void {
  if (store.icons.has(path)) return;
  pending.add(path);
  if (scheduled) return;
  scheduled = true;
  // One postMessage for all chips mounted in the same frame, not one per chip.
  queueMicrotask(() => {
    scheduled = false;
    if (!pending.size) return;
    const paths = [...pending];
    pending = new Set();
    post({ type: "fileIcons", paths });
  });
}

export function useFileIcon(path?: string): FileIconData | null | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (path) requestIcon(path);
  }, [path, store.version]);
  return path ? store.icons.get(path) : undefined;
}

export function FileTypeIcon({ path }: { path?: string }) {
  const icon = useFileIcon(path);
  const { Icon, className } = fileIcon(path);
  if (icon?.kind === "svg") {
    return <img class={`file-icon themed ${className}`} src={icon.src} alt="" aria-hidden="true" draggable={false} />;
  }
  if (icon?.kind === "font") {
    return (
      <span
        class={`file-icon themed font ${className}`}
        aria-hidden="true"
        style={{ fontFamily: icon.fontFamily, color: icon.color, fontSize: icon.size }}
      >
        {icon.glyph}
      </span>
    );
  }
  return <Icon class={`file-icon ${className}`} />;
}
