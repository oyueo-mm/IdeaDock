// WebCrypto only, so the same code runs in Cloudflare Workers, Node and tests.
const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(value: string) {
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
/** Unpredictable identifier: 32 bytes from the platform CSPRNG. */
export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}
export async function sha256Hex(value: string) {
  return [...(await sha256(value))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/** RFC 7636 S256 challenge for a PKCE verifier. */
export async function pkceChallenge(verifier: string) {
  return base64url(await sha256(verifier));
}

/**
 * AES-256-GCM with a fresh 96-bit IV per message. `context` is bound as
 * additional data, so a ciphertext copied to another account row or into a
 * cookie fails to decrypt. Format: `v1.<iv>.<ciphertext+tag>`.
 */
export class Sealer {
  private readonly key: CryptoKey;
  private constructor(key: CryptoKey) {
    this.key = key;
  }
  static async fromSecret(secret: string | undefined) {
    let raw: Uint8Array;
    try {
      raw = fromBase64url((secret ?? "").trim());
    } catch {
      raw = new Uint8Array();
    }
    if (raw.length !== 32)
      throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes (base64).");
    const key = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return new Sealer(key);
  }
  async seal(plain: string, context: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      this.key,
      encoder.encode(plain),
    );
    return `v1.${base64url(iv)}.${base64url(new Uint8Array(data))}`;
  }
  /** Returns null for anything tampered, truncated or sealed for another context. */
  async open(sealed: string | null | undefined, context: string) {
    const [version, iv, data] = (sealed ?? "").split(".");
    if (version !== "v1" || !iv || !data) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64url(iv) as BufferSource,
          additionalData: encoder.encode(context),
        },
        this.key,
        fromBase64url(data) as BufferSource,
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
