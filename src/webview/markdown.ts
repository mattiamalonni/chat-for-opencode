import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";
import { fileRefToOpenPath, findFileRefs } from "../shared/fileRef";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Beyond this a code block is escaped, not highlighted: hljs tokenises the whole string on every
 * streaming frame, so a huge paste can dominate render time. Tool output already has a similar cap. */
const MAX_HIGHLIGHT_CHARS = 20_000;
/** Bound the render cache by both entries and rough size; streamed deltas are all distinct keys. */
const MAX_CACHE_ENTRIES = 300;
const MAX_CACHE_CHARS = 2_000_000;

let copyLabel = "Copy";
export function setCopyLabel(label: string): void {
  copyLabel = label;
  cache.clear();
  cacheChars = 0;
}

export function highlight(code: string, lang?: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

// DOMPurify keeps `class`, so a reply could forge the renderer's `.code-block .code-header
// .code-copy` structure and regain the copy handler with attacker-chosen text. Mark our own buttons
// with a class generated per page load: untrusted markdown cannot guess it, and it never appears in
// a stored message or in the protocol.
const copyMarker = `code-copy-${Math.random().toString(36).slice(2)}`;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return (
        `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(language)}</span>` +
        `<button type="button" class="code-copy ${copyMarker}" data-action="copy-code">${escapeHtml(copyLabel)}</button></div>` +
        `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlight(text, language)}</code></pre></div>`
      );
    },
  },
});

const cache = new Map<string, string>();
let cacheChars = 0;

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
 * Wraps query matches in `<mark>` inside already-sanitised HTML. Walking text nodes (instead of
 * string-replacing the HTML) keeps Markdown formatting, links and code structure intact and never
 * re-parses model-controlled markup a second time.
 */
function highlightTextNodes(root: HTMLElement, query: string): void {
  const needle = query.toLowerCase();
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const value = node.nodeValue ?? "";
    const lower = value.toLowerCase();
    if (!lower.includes(needle)) continue;
    const fragment = document.createDocumentFragment();
    let from = 0;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      if (at > from) fragment.append(value.slice(from, at));
      const mark = document.createElement("mark");
      mark.dataset.searchMatch = "true";
      mark.textContent = value.slice(at, at + needle.length);
      fragment.append(mark);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    fragment.append(value.slice(from));
    node.parentNode?.replaceChild(fragment, node);
  }
}

/**
 * Markdown → sanitised HTML, optionally with search matches marked. The cache only holds the
 * unmarked variant: a query changes far more often than a message and marking is cheap.
 */
export function renderMarkdown(source: string, query = ""): string {
  const search = query.trim().toLowerCase();
  if (!search) {
    const hit = cache.get(source);
    if (hit !== undefined) return hit;
  }
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
  // Restore `data-action` only on buttons the renderer marked. A reply with the same static classes
  // but no marker stays inert (and the delegate in app.tsx never copies anything from it).
  for (const button of dom.body.querySelectorAll<HTMLElement>(`.code-block .code-header .code-copy.${copyMarker}`)) {
    button.dataset.action = "copy-code";
  }
  linkifyFileRefs(dom.body);
  highlightTextNodes(dom.body, search);
  const html = dom.body.innerHTML;
  if (search) return html;
  cache.set(source, html);
  cacheChars += source.length + html.length;
  while (cache.size > MAX_CACHE_ENTRIES || cacheChars > MAX_CACHE_CHARS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cacheChars -= oldest.length + (cache.get(oldest)?.length ?? 0);
    cache.delete(oldest);
  }
  return html;
}
