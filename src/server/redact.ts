/**
 * Credential redaction for anything derived from a server process.
 *
 * The managed server's password is generated here and sent to the child as `OPENCODE_PASSWORD`, but
 * a child (or a proxy it talks to) can echo it in many encodings: raw, as the Basic auth value,
 * URL-encoded, hex, or inside a serialised header. Redacting only the raw form left the Base64
 * variant in stderr, which then reached `ServerError.detail` and the chat UI. Redact all known
 * representations and any Basic credential, even when we don't know the password (external server).
 */

const REDACTED = "***";

function replaceAll(text: string, needle: string, replacement: string): string {
  // A needle shorter than four characters would redact unrelated log text.
  return needle.length >= 4 ? text.split(needle).join(replacement) : text;
}

export function redactSecrets(text: string, secret?: string): string {
  if (!text) return "";
  let out = text;

  if (secret) {
    const basic = Buffer.from(`opencode:${secret}`, "utf8");
    // Most specific encodings first; the raw value is handled last so it cannot split a longer one.
    for (const variant of [
      basic.toString("base64"),
      basic.toString("base64url"),
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("hex"),
      secret,
    ]) {
      out = replaceAll(out, variant, REDACTED);
    }
    // Env dumps may quote or re-encode the value, so drop the whole assignment even if the raw
    // form above did not match.
    out = out.replace(/(OPENCODE_PASSWORD\s*[=:]\s*)(["']?)([^\s"',;]+)\2/gi, `$1$2${REDACTED}$2`);
  }

  // Userinfo in a URL, e.g. `https://user:token@host` — the raw endpoint should never be logged,
  // but keep this as defence in depth for messages built before normalization.
  out = out.replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***:***@");
  // JSON-serialised headers from HTTP debug logs: keep the field, mask the credential.
  out = out.replace(/("authorization"\s*:\s*")([^"]+)(")/gi, `$1${REDACTED}$3`);
  // Plain `Authorization: Basic <token>` / `Basic <token>` lines, including external servers whose
  // password this process never sees.
  out = out.replace(
    /(authorization\s*:\s*)?(Basic|Bearer)\s+([A-Za-z0-9+/=_-]{8,})/gi,
    (_match, prefix: string | undefined, scheme: string) => `${prefix ?? ""}${scheme} ${REDACTED}`,
  );
  // Managed server's human-readable startup line.
  out = out.replace(/(server password\s+)\S+/gi, `$1${REDACTED}`);
  return out;
}
