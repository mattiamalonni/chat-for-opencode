/** Helpers for the on-disk copies of inline attachments, so their chips can be opened in the editor. */
import * as path from "node:path";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "text/csv": ".csv",
};

export function extensionForMime(mime: string | undefined): string {
  if (!mime) return ".bin";
  return EXT_BY_MIME[mime.split(";")[0].trim().toLowerCase()] ?? ".bin";
}

/** Clipboard files often have no usable name or extension: keep a safe basename and add one from MIME. */
export function attachmentFileName(name: string, mime?: string): string {
  const base =
    Array.from(path.basename(name.replace(/\\/g, "/")))
      .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch))
      .join("")
      .replace(/^\.+/, "")
      .trim() || "attachment";
  const ext = path.extname(base).toLowerCase();
  return ext ? base : `${base}${extensionForMime(mime)}`;
}

/** True when `file` is `dir` itself or lives below it. */
export function isWithinDirectory(file: string, dir: string): boolean {
  const root = path.resolve(dir);
  const target = path.resolve(file);
  if (process.platform === "win32") {
    const lowerRoot = root.toLowerCase();
    const lowerTarget = target.toLowerCase();
    return lowerTarget === lowerRoot || lowerTarget.startsWith(lowerRoot + path.sep);
  }
  return target === root || target.startsWith(root + path.sep);
}
