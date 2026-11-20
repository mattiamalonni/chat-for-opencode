import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";
import { fileRefToOpenPath, findFileRefs } from "../shared/fileRef";

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

/** Code and existing links keep their text: only prose gets clickable file references. */
const LINKIFY_SKIP = "pre, code, a, script, style, textarea";

/**
 * Turns `src/app.ts:42` in prose into a link the host can open at the exact line.
 *
 * We use a `data-file` attribute instead of an `href` with a path: DOMPurify (rightly) rejects
 * hrefs whose scheme it cannot recognise, and `foo.ts:42` looks like a custom scheme to it.
 * The click is handled by the delegate in `app.tsx`, which posts `openFile` with this value.
 */
function linkifyFileRefs(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const value = node.nodeValue ?? "";
    if (!value || node.parentElement?.closest(LINKIFY_SKIP)) continue;
    const refs = findFileRefs(value);
    if (refs.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const ref of refs) {
      if (ref.start < cursor) continue;
      fragment.append(value.slice(cursor, ref.start));
      const link = document.createElement("a");
      link.href = "#";
      link.className = "file-ref";
      link.textContent = ref.text;
      link.title = ref.text;
      link.setAttribute("data-file", fileRefToOpenPath(ref.text));
      fragment.append(link);
      cursor = ref.start + ref.text.length;
    }
    fragment.append(value.slice(cursor));
    node.parentNode?.replaceChild(fragment, node);
  }
}

/**
 * Markdown → sanitised HTML. The cache helps when a message component remounts or the same text is
 * rendered again; streaming deltas are new strings each frame, so `Markdown`'s `useMemo([text])`
 * is what avoids re-rendering completed parts.
 */
export function renderMarkdown(source: string): string {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  const raw = marked.parse(source, { async: false }) as string;
  // Sanitise the model's HTML *before* linkifying. DOMPurify keeps `data-*` attributes by default,
  // so adding our `data-file` links first would let a crafted `<a data-file="...">` in a reply
  // survive as a clickable local-file link. FORBID_ATTR is defence in depth for the same reason.
  const clean = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe"],
    // Our code-block buttons get `data-action` back in the DOM pass below. Forbidding it here
    // stops a reply from smuggling in a fake "Copy" button that copies attacker-chosen text.
    FORBID_ATTR: ["style", "data-file", "data-action"],
  });
  const dom = new DOMParser().parseFromString(clean, "text/html");
  for (const button of dom.body.querySelectorAll<HTMLElement>(".code-block .code-header .code-copy")) {
    button.dataset.action = "copy-code";
  }
  linkifyFileRefs(dom.body);
  const html = dom.body.innerHTML;
  cache.set(source, html);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return html;
}
