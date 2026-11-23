import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FileAttachment } from "../shared/api";

/** OpenCode rejects decoded attachments above this size. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface AttachmentLike {
  uri: string;
  name?: string;
  label?: string;
}

type ResolveResult =
  | { status: "ok"; attachment: FileAttachment }
  | { status: "tooLarge"; name: string }
  | { status: "unreadable"; name: string; detail: string };

/**
 * A managed server runs on this machine and can read local `file:` URIs itself. An external server
 * (`opencode.endpoint`) may live in a container, on another host or behind a different mount
 * namespace, where our local paths do not exist: OpenCode then fails with
 * "Unable to read attachment: <uri>". In that case send the bytes inline as a `data:` URL so the
 * model always receives the file. `data:` URIs already carry their content and pass through.
 */
export function mustInline(uri: string, externalServer: boolean): boolean {
  return externalServer && uri.startsWith("file:");
}

/** Converts a `file:` attachment URI to a local path, dropping the optional `?start=&end=` range. */
export function localPathFromUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return undefined;
    url.search = "";
    url.hash = "";
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function positiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Applies the 1-based, inclusive `?start=&end=` line range carried by selection attachments.
 * Mirrors what OpenCode does when it reads a ranged `file:` URI itself.
 */
export function sliceLines(bytes: Buffer, uri: string): Buffer {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return bytes;
  }
  const start = positiveInt(url.searchParams.get("start"));
  const end = positiveInt(url.searchParams.get("end"));
  if (start === undefined && end === undefined) return bytes;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  return Buffer.from(lines.slice((start ?? 1) - 1, end).join("\n"));
}

/** Resolves one staged attachment/context item into the shape the prompt API expects. */
export async function resolveAttachment(
  item: AttachmentLike,
  externalServer: boolean,
  mimeFor: (name: string) => string,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<ResolveResult> {
  const name = item.name ?? item.label ?? "attachment";
  if (!mustInline(item.uri, externalServer)) {
    return { status: "ok", attachment: { uri: item.uri, name } };
  }
  const filePath = localPathFromUri(item.uri);
  if (!filePath) {
    return { status: "unreadable", name, detail: `Unsupported attachment URI: ${item.uri}` };
  }
  try {
    const info = await stat(filePath);
    if (info.size > maxBytes) return { status: "tooLarge", name };
    const bytes = sliceLines(await readFile(filePath), item.uri);
    return { status: "ok", attachment: { uri: `data:${mimeFor(name)};base64,${bytes.toString("base64")}`, name } };
  } catch (err) {
    return { status: "unreadable", name, detail: err instanceof Error ? err.message : String(err) };
  }
}
