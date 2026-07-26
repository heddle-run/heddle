/**
 * Short-lived tokens that let one container instance reach the model proxy.
 *
 * The container cannot be given the model API key. heddle resolves both the
 * base URL and the credential from the *submitted spec* — a flow can set
 * `url` to any endpoint and `api_key` to `$SOME_VAR` — so anything secret in
 * that environment leaves with the first request a caller writes. No plugin is
 * required; an ordinary flow does it.
 *
 * So the container gets a token instead. It is signed, it names one run, it
 * expires in minutes, and it buys nothing except calls to our own proxy, which
 * counts them. A caller who extracts it from the environment has stolen a few
 * minutes of the quota they already had.
 */

const ENCODER = new TextEncoder();

export interface RunToken {
  runId: string;
  /** Seconds since the epoch, after which the proxy refuses the token. */
  expiresAt: number;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    ENCODER.encode(payload),
  );
  return base64url(signature);
}

/** Mint a token for one run. */
export async function mintToken(
  secret: string,
  runId: string,
  ttlSeconds: number,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${runId}.${expiresAt}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/**
 * Verify a token, returning what it claims or undefined.
 *
 * The signature is compared in constant time. A token is three dot-separated
 * fields, so the run id must not contain a dot — the caller mints them, and
 * `crypto.randomUUID()` does not.
 */
export async function verifyToken(
  secret: string,
  token: string,
): Promise<RunToken | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [runId, rawExpiry, signature] = parts;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt)) return undefined;

  const expected = await sign(secret, `${runId}.${rawExpiry}`);
  if (!timingSafeEqual(signature, expected)) return undefined;

  // Checked after the signature, so an expired token and a forged one take the
  // same path and cannot be told apart by how long the answer takes.
  if (expiresAt < Math.floor(Date.now() / 1000)) return undefined;

  return { runId, expiresAt };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
