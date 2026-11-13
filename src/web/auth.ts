import type { Env } from "../env";
import { LiaiseError } from "../core/errors";
import { hitRate, RATES } from "../core/infra";
import { upsertPerson } from "../core/people";
import { base64url, base64urlDecode, emailDomain, isLoopbackHost, normalizeEmail, now, randomToken, sha256, timingSafeEqual } from "../core/util";
import { html, page, redirect } from "./html";
import { cookieName, createSession, destroySession, getSession, readCookie, safeReturnTo, setCookie, checkedForm } from "./session";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export function devLoginEnabled(env: Env): boolean {
  return env.DEV_LOGIN === "unsafe-local-only" && isLoopbackHost(new URL(env.PUBLIC_ORIGIN).hostname);
}

export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function loginUrl(returnTo: string, fresh = false): string {
  return `/auth/login?return_to=${encodeURIComponent(returnTo)}${fresh ? "&fresh=1" : ""}`;
}

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  switch (url.pathname) {
    case "/auth/login": {
      try {
        await hitRate(env.DB, `signin:${ip}`, RATES.signInsPerIpPerHour, 3600);
      } catch {
        return page("Too many sign-ins", html`<h1>Too many sign-in attempts</h1><p>Wait a while and try again.</p>`, { status: 429 });
      }
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));
      const fresh = url.searchParams.get("fresh") === "1";
      if (googleEnabled(env)) return startGoogle(env, returnTo, fresh);
      if (devLoginEnabled(env)) return redirect(`/auth/dev-login?return_to=${encodeURIComponent(returnTo)}`);
      return page("Sign-in not configured", html`<h1>Sign-in is not configured</h1>
        <p>The operator has not set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. See docs/deploy.md.</p>`, { status: 503 });
    }
    case "/auth/callback":
      return finishGoogle(request, env, url);
    case "/auth/dev-login":
      return devLogin(request, env, url);
    case "/auth/logout": {
      const session = await getSession(request, env);
      if (!session) return redirect("/");
      const form = await checkedForm(request, env, session);
      if (!form) return page("Not allowed", html`<h1>That request was not allowed</h1>`, { status: 403 });
      return redirect("/", { "set-cookie": await destroySession(env, session) });
    }
  }
  return page("Not found", html`<h1>Not found</h1>`, { status: 404 });
}

async function startGoogle(env: Env, returnTo: string, fresh: boolean): Promise<Response> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const t = now();
  await env.DB.prepare(
    "INSERT INTO login_attempts (state_hash, nonce, verifier, return_to, fresh, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256(state), nonce, verifier, returnTo, fresh ? 1 : 0, t, t + 600)
    .run();
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Always show the account chooser. "Sign in again" also asks Google to re-authenticate the person
  // (max_age=0), and the callback checks the returned auth_time.
  u.searchParams.set("prompt", "select_account");
  if (fresh) u.searchParams.set("max_age", "0");
  // The state is also kept in a cookie so a sign-in started in another browser cannot be finished here.
  return redirect(u.toString(), { "set-cookie": setCookie(env, "login", state, 600) });
}

async function finishGoogle(request: Request, env: Env, url: URL): Promise<Response> {
  const bad = (why: string) =>
    page("Sign-in failed", html`<h1>Sign-in failed</h1><p>${why}</p><p><a href="/auth/login">Try again</a></p>`, { status: 400 });
  if (!googleEnabled(env)) return bad("Google sign-in is not configured.");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieState = readCookie(request, cookieName(env, "login"));
  if (!state || !code || !cookieState || !timingSafeEqual(state, cookieState)) return bad("The sign-in could not be matched to this browser.");
  const stateHash = await sha256(state);
  const attempt = await env.DB.prepare("DELETE FROM login_attempts WHERE state_hash = ? AND expires_at > ? RETURNING *")
    .bind(stateHash, now())
    .first<{ nonce: string; verifier: string; return_to: string; fresh: number; created_at: number }>();
  if (!attempt) return bad("The sign-in expired. Please try again.");

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: attempt.verifier,
    }),
  });
  if (!tokenRes.ok) return bad("Google did not accept the sign-in.");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  // The ID token came straight from Google's token endpoint over TLS, so its signature need not
  // be re-checked (OpenID Connect Core 3.1.3.7); its claims still are.
  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims) return bad("Google returned an unreadable ID token.");
  const t = now();
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) return bad("Unexpected issuer.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.GOOGLE_CLIENT_ID)) return bad("The ID token is for another client.");
  if (typeof claims.exp !== "number" || claims.exp < t) return bad("The ID token expired.");
  if (typeof claims.nonce !== "string" || !timingSafeEqual(claims.nonce, attempt.nonce)) return bad("The sign-in could not be verified.");
  if (typeof claims.sub !== "string" || !claims.sub) return bad("No account id.");
  if (claims.email_verified !== true || typeof claims.email !== "string") return bad("Liaise needs a Google account with a verified email address.");
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : null;
  if (attempt.fresh && (authTime === null || authTime < attempt.created_at - 60)) return bad("Google did not ask you to sign in again. Please try again.");
  if (!(await mayUseInstance(env, "google", claims.sub, claims.email))) {
    return bad("This Liaise instance is open to invited people only. Ask the person who invited you to send the invite to this address.");
  }

  const person = await upsertPerson(env.DB, "google", claims.sub, claims.email, typeof claims.name === "string" ? claims.name : "");
  const headers = new Headers({ location: safeReturnTo(attempt.return_to), "cache-control": "no-store" });
  await endPreviousSession(request, env);
  // Fresh means a verified recent authentication: an ordinary sign-in without auth_time never is.
  headers.append("set-cookie", await createSession(env, person.id, authTime ?? 0));
  headers.append("set-cookie", setCookie(env, "login", "", 0));
  return new Response(null, { status: 303, headers });
}

/**
 * With SIGNUP_ALLOWLIST set, only listed emails or @domains may sign up. People who already have
 * an account, and people holding a confirmed invite, may always sign in.
 */
async function mayUseInstance(env: Env, provider: string, subject: string, rawEmail: string): Promise<boolean> {
  const list = (env.SIGNUP_ALLOWLIST ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  if (list.includes(email) || list.includes(`@${emailDomain(email)}`)) return true;
  const known = await env.DB.prepare("SELECT 1 FROM people WHERE provider = ? AND subject = ?").bind(provider, subject).first();
  if (known) return true;
  const invited = await env.DB.prepare("SELECT 1 FROM invites WHERE email = ? AND status = 'confirmed' AND expires_at > ?").bind(email, now()).first();
  return Boolean(invited);
}

async function endPreviousSession(request: Request, env: Env): Promise<void> {
  const old = await getSession(request, env);
  if (old) await destroySession(env, old);
}

function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Local-only sign-in for `wrangler dev`, tests and the demo. Never available on a public origin. */
async function devLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!devLoginEnabled(env)) return page("Not found", html`<h1>Not found</h1>`, { status: 404 });
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  if (request.method === "POST") {
    if (request.headers.get("origin") !== env.PUBLIC_ORIGIN) return page("Not allowed", html`<h1>Not allowed</h1>`, { status: 403 });
    const form = await request.formData();
    const email = String(form.get("email") ?? "");
    const name = String(form.get("name") ?? "");
    try {
      if (!(await mayUseInstance(env, "dev", email.trim().toLowerCase(), email))) {
        return page("Not invited", html`<h1>This instance is open to invited people only</h1>`, { status: 403 });
      }
      const person = await upsertPerson(env.DB, "dev", email.trim().toLowerCase(), email, name);
      await endPreviousSession(request, env);
      return redirect(returnTo, { "set-cookie": await createSession(env, person.id) });
    } catch (e) {
      if (e instanceof LiaiseError) return page("Sign-in failed", html`<h1>${e.message}</h1>`, { status: 400 });
      throw e;
    }
  }
  return page(
    "Local sign-in",
    html`<h1>Local sign-in</h1>
      <p class="warn">Development only. This page exists because DEV_LOGIN is set and the instance runs on a loopback address.
      Anyone who can reach it can sign in as anyone.</p>
      <form method="post" action="/auth/dev-login?return_to=${encodeURIComponent(returnTo)}" class="card">
        <label>Email <input type="email" name="email" required autofocus></label>
        <label>Name <input type="text" name="name"></label>
        <button class="primary">Sign in</button>
      </form>`,
  );
}
