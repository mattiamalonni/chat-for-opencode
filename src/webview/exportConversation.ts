import { chatReducer } from "../shared/chatReducer";

import { format, STRINGS, type Strings } from "../shared/strings";

/** Turns the in-memory chat into a portable, readable Markdown transcript. */
export function conversationMarkdown(messages: ReturnType<typeof chatReducer>["messages"], title: string, strings: Strings): string {
  const text = (key: keyof Strings, ...args: (string | number)[]) => format(strings[key] ?? STRINGS[key], ...args);
  const lines: string[] = [`# ${title || STRINGS.appName}`, ""];
  for (const m of messages) {
    if (m.kind === "user") {
      lines.push(`## ${text("you")}`, "", m.text, "");
      for (const f of m.files) lines.push(`- \`${f.name ?? f.uri}\``);
      if (m.files.length > 0) lines.push("");
      continue;
    }
    if (m.kind === "notice") {
      lines.push(`> **${m.level}:** ${m.text.replace(/\s*\n\s*/g, " ")}`, "");
      continue;
    }
    for (const p of m.parts) {
      if (p.kind === "tool") {
        lines.push(`> **${text("tool")}:** \`${p.name}\`${p.status === "error" ? ` (${text("failed")})` : ""}`);
        for (const l of p.inputText.split("\n")) lines.push(`> ${l}`);
        const output = p.output.map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`)).join("\n");
        for (const l of output.split("\n")) if (l) lines.push(`> ${l}`);
        lines.push("");
      } else if (p.kind === "text") {
        lines.push(p.text, "");
      } else if (p.text.trim()) {
        lines.push("<details><summary>Thoughts</summary>", "", p.text, "", "</details>", "");
      }
    }
    if (m.error?.message) lines.push(`> **${text("error")}:** ${m.error.message}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Blob + anchor download: works under the webview CSP (no `connect-src` needed) and sends nothing to the host. */
export function downloadFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
