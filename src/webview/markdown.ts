import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let copyLabel = "Copy";
export function setCopyLabel(label: string): void {
  copyLabel = label;
  cache.clear();
}

export function highlight(code: string, lang?: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return (
        `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(language)}</span>` +
        `<button type="button" class="code-copy" data-action="copy-code">${escapeHtml(copyLabel)}</button></div>` +
        `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlight(text, language)}</code></pre></div>`
      );
    },
  },
});

const cache = new Map<string, string>();

/**
 * Markdown → sanitised HTML. The cache helps when a message component remounts or the same text is
 * rendered again; streaming deltas are new strings each frame, so `Markdown`'s `useMemo([text])`
 * is what avoids re-rendering completed parts.
 */
export function renderMarkdown(source: string): string {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  const raw = marked.parse(source, { async: false }) as string;
  const html = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe"],
    FORBID_ATTR: ["style"],
  });
  cache.set(source, html);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return html;
}
