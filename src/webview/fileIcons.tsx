import type { FunctionComponent, SVGAttributes } from "preact";
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

type Icon = FunctionComponent<SVGAttributes<SVGSVGElement>>;

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "c", "cc", "cpp", "h", "hpp",
  "cs", "rb", "php", "swift", "kt", "kts", "scala", "lua", "vue", "svelte", "astro",
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

export function FileTypeIcon({ path }: { path?: string }) {
  const { Icon, className } = fileIcon(path);
  return <Icon class={`file-icon ${className}`} />;
}
