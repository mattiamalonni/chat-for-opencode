/**
 * Normalize a user-configured server endpoint before it is used as an address, a log detail or a
 * SecretStorage key. `https://user:token@host` embeds a credential in the URL: SecretStorage keys
 * are not encrypted, and the raw string also reaches the Output channel and error banners.
 */
export interface NormalizedEndpoint {
  /** Endpoint without userinfo; safe to log and to use as a storage key. */
  baseUrl: string;
  /** Password embedded in userinfo, used as a fallback when no password was stored explicitly. */
  password?: string;
}

export function normalizeEndpoint(raw: string): NormalizedEndpoint {
  try {
    const url = new URL(raw);
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    url.username = "";
    url.password = "";
    // Keep the existing shape of the setting (no trailing slash), so concrete endpoints compare
    // equal to what the managed server writes into its Connection.
    return { baseUrl: url.toString().replace(/\/$/, ""), password };
  } catch {
    // A malformed endpoint is rejected later by the HTTP client; never let its userinfo leak into
    // a key or a log line in the meantime.
    return { baseUrl: raw.replace(/\/\/[^/@]*@/, "//***@") };
  }
}
