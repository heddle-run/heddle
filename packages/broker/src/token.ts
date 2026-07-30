const ENCODER = new TextEncoder();

const MS_PER_SECOND = 1000;
const TOKEN_FIELDS = 3;
const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

export interface RunToken {
  runId: string;
  expiresAt: number;
}

export async function mintToken(
  secret: string,
  runId: string,
  ttlSeconds: number,
): Promise<string> {
  const expiresAt = nowInSeconds() + ttlSeconds;
  const payload = `${runId}.${expiresAt}`;

  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifyToken(
  secret: string,
  token: string,
): Promise<RunToken | undefined> {
  const parts = token.split(".");
  if (parts.length !== TOKEN_FIELDS) return undefined;

  const [runId, rawExpiry, signature] = parts;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt)) return undefined;

  const expected = await sign(secret, `${runId}.${rawExpiry}`);
  if (!timingSafeEqual(signature, expected)) return undefined;

  if (expiresAt < nowInSeconds()) return undefined;

  return { runId, expiresAt };
}

async function sign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    ENCODER.encode(payload),
  );
  return base64url(signature);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    HMAC_ALGORITHM,
    false,
    ["sign"],
  );
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}
