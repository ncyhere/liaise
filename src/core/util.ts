export const SECOND = 1;
export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A random id with a readable prefix, e.g. "room_k3m9...". 20 chars of ~5 bits each. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

/** A URL-safe secret with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(digest);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Removes invisible and control characters that can hide text from a human reader or smuggle
 * instructions to a model: format characters (zero-width, bidi overrides), tag characters,
 * variation selectors and C0/C1 controls other than newline and tab. Also normalises newlines
 * and applies NFC.
 */
export function stripInvisible(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .replace(/[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** Single-line text: invisible characters stripped, whitespace collapsed, length capped. */
export function oneLine(s: string, max: number): string {
  const t = stripInvisible(s).replace(/\s+/g, " ").trim();
  return [...t].slice(0, max).join("");
}

/** A display name reduced to a conservative character set, for lines shown outside fences. */
export function safeName(s: string): string {
  const t = oneLine(s, 60).replace(/[^\p{L}\p{M}\p{N} .'\-]/gu, "").trim();
  return t || "Someone";
}

/** A connection label: chosen by its person, shown to other members, kept to a plain charset. */
export function safeLabel(s: string): string {
  return oneLine(s, 40).replace(/[^A-Za-z0-9 ._\-()]/g, "").trim();
}

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

export function normalizeEmail(s: string): string | null {
  const e = s.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Canonical JSON (sorted keys) so stored approval parameters compare exactly. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA-256 with the server's HASH_KEY, base64url. Used instead of plain hashes everywhere. */
export async function keyedHash(secret: string, text: string): Promise<string> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, key);
  }
  const sig = await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(text));
  return base64url(sig);
}
