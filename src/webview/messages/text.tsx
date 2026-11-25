import { toolOutputLabel } from "../../shared/toolOutput";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { type TextPart, type UiAssistantMessage, type UiMessage } from "../../shared/chatReducer";

import { renderMarkdown } from "../markdown";

/** URI decoding can throw on malformed escapes; never let that take down the whole chat. */
export function fileNameOf(uri: string): string {
  const raw = uri.split("/").pop() ?? uri;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Splits a path into its file name and parent directory (with trailing separator). Accepts both POSIX and Windows separators. */
export function splitFilePath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Plain-text representation used for header search and Markdown export. Messages are immutable
 * (the reducer allocates a new object only for the one that changed), so cache by identity: the
 * search count and the export avoid rebuilding strings for unchanged messages each frame.
 */
const searchTextCache = new WeakMap<UiMessage, string>();
export function messageSearchText(message: UiMessage): string {
  const cached = searchTextCache.get(message);
  if (cached !== undefined) return cached;
  let text: string;
  if (message.kind === "assistant") {
    const parts = message.parts.map((p) =>
      p.kind === "tool" ? [p.name, p.inputText, ...p.output.map((c) => toolOutputLabel(c))].join(" ") : p.text,
    );
    text = [...parts, message.error?.message ?? "", message.retry?.message ?? ""].join(" ");
  } else {
    text = message.text;
  }
  searchTextCache.set(message, text);
  return text;
}

/**
 * Only the text the reader actually sees. `messageSearchText` also folds tool I/O and reasoning
 * into one string for search/export, which is wrong for the "Copy this response" action.
 */
export function visibleResponseText(message: UiAssistantMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Highlights a query in plain text. Markdown bodies keep their rendered HTML and are not rewritten. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const children: (string | ComponentChildren)[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  let i = 0;
  while (at !== -1) {
    if (at > from) children.push(text.slice(from, at));
    children.push(
      <mark key={`m${i++}`} data-search-match="true">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) children.push(text.slice(from));
  return <>{children}</>;
}

/**
 * Search marks the text *inside* the rendered Markdown, so bold/code/links keep their formatting.
 * `renderMarkdown` sanitises first and marks text nodes afterwards; no untrusted HTML is reparsed.
 */
export function SearchableMarkdown({ text, query }: { text: string; query: string }) {
  const html = useMemo(() => renderMarkdown(text, query), [text, query]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
