import type { Env } from "../env";
import { LIMITS, type Person } from "../core/model";
import { now, randomToken, sha256, timingSafeEqual } from "../core/util";

export interface WebSession {
  person: Person;
  sessionHash: string;
  csrf: string;
  authTime: number;
}

export function isHttps(env: Env): boolean {
  return env.PUBLIC_ORIGIN.startsWith("https://");
}

/** `__Host-` cookies need HTTPS; local http://localhost uses an unprefixed name. */
export function cookieName(env: Env, base: string): string {
  return isHttps(env) ? `__Host-liaise_${base}` : `liaise_${base}`;
}

export function setCookie(env: Env, base: string, value: string, maxAge: number): string {
  const parts = [`${cookieName(env, base)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isHttps(env)) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function getSession(request: Request, env: Env): Promise<WebSession | null> {
  const token = readCookie(request, cookieName(env, "session"));
  if (!token || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.csrf, s.auth_time, p.* FROM web_sessions s JOIN people p ON p.id = s.person_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, now())
    .first<Person & { csrf: string; auth_time: number }>();
  if (!row) return null;
  const { csrf, auth_time, ...person } = row;
  return { person, sessionHash: hash, csrf, authTime: auth_time };
}

/** Creates a session after a completed sign-in; returns the Set-Cookie header value. */
export async function createSession(env: Env, personId: string): Promise<string> {
  const token = randomToken();
  const t = now();
  await env.DB.prepare("INSERT INTO web_sessions (id_hash, person_id, csrf, auth_time, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), personId, randomToken(), t, t, t + LIMITS.webSessionTtl)
    .run();
  return setCookie(env, "session", token, LIMITS.webSessionTtl);
}

export async function destroySession(env: Env, session: WebSession): Promise<string> {
  await env.DB.prepare("DELETE FROM web_sessions WHERE id_hash = ?").bind(session.sessionHash).run();
  return setCookie(env, "session", "", 0);
}

export function isFresh(session: WebSession): boolean {
  return now() - session.authTime <= LIMITS.freshSignIn;
}

/**
 * Every state-changing web request: POST only, from this exact origin, with the session's CSRF
 * token. Returns the parsed form, or null when any check fails.
 */
export async function checkedForm(request: Request, env: Env, session: WebSession): Promise<FormData | null> {
  if (request.method !== "POST") return null;
  if (request.headers.get("origin") !== env.PUBLIC_ORIGIN) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return null;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return null;
  const form = await request.formData();
  const csrf = form.get("csrf");
  if (typeof csrf !== "string" || !timingSafeEqual(csrf, session.csrf)) return null;
  return form;
}

/** Only same-origin relative paths are allowed as post-sign-in destinations. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 2000) return "/app";
  return value;
}
