import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { hitRate, RATES } from "./core/infra";
import { LIMITS } from "./core/model";
import { DAY, isLoopbackHost, now } from "./core/util";
import { mcpHandler } from "./mcp/handler";
import { webHandler } from "./web/router";

export { type Env };

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per configured origin (the resource URL is part of its configuration). */
function providerFor(env: Env): OAuthProvider<Env> {
  let p = providers.get(env.PUBLIC_ORIGIN);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: webHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      accessTokenTTL: 15 * 60,
      // A grant expires after 30 days without a refresh. The hard 90-day cap per connection is
      // enforced in D1 on every request (connections.expires_at).
      refreshTokenTTL: 30 * DAY,
      refreshTokenIdleTTL: 30 * DAY,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, resource_name: "Liaise" },
    });
    providers.set(env.PUBLIC_ORIGIN, p);
  }
  return p;
}

function configError(env: Env): string | null {
  let origin: URL;
  try {
    origin = new URL(env.PUBLIC_ORIGIN);
  } catch {
    return "PUBLIC_ORIGIN is not a URL.";
  }
  if (origin.origin !== env.PUBLIC_ORIGIN) return "PUBLIC_ORIGIN must be an origin only (scheme, host, port; no path or trailing slash).";
  const loopback = isLoopbackHost(origin.hostname);
  if (origin.protocol !== "https:" && !loopback) return "PUBLIC_ORIGIN must use https.";
  // Fail closed: the local sign-in must never exist on a reachable instance.
  if (env.DEV_LOGIN && !loopback) return "DEV_LOGIN is set on a non-local origin. Remove it.";
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const problem = configError(env);
    if (problem) {
      console.error(`refusing to serve: ${problem}`);
      return new Response(`Liaise is misconfigured: ${problem}`, { status: 500 });
    }
    const url = new URL(request.url);
    // One canonical origin, so cookies, CSRF checks and token audiences all agree.
    if (url.origin !== env.PUBLIC_ORIGIN) {
      if (request.method === "GET" || request.method === "HEAD") {
        return Response.redirect(env.PUBLIC_ORIGIN + url.pathname + url.search, 308);
      }
      return new Response("Wrong origin for this instance.", { status: 421 });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") ?? "local";
      try {
        await hitRate(env.DB, `reg:${ip}`, RATES.registrationsPerIpPerHour, 3600);
        await hitRate(env.DB, "reg:global", RATES.registrationsGlobalPerHour, 3600);
      } catch {
        return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many registrations." }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3600" },
        });
      }
    }
    return providerFor(env).fetch(request, env, ctx);
  },

  /** Expiry and clean-up. Every read path also checks expiry itself, so this is housekeeping. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const t = now();
    const db = env.DB;
    await db.batch([
      db.prepare("UPDATE posts SET status = 'expired', decided_at = ? WHERE status = 'held' AND created_at <= ?").bind(t, t - LIMITS.heldPostTtl),
      db.prepare("UPDATE invites SET status = 'expired' WHERE status IN ('proposed', 'confirmed') AND expires_at <= ?").bind(t),
      db.prepare("DELETE FROM approvals WHERE expires_at <= ?").bind(t - DAY),
      db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(t),
      db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").bind(t),
      db.prepare("DELETE FROM rate_counters WHERE window_start <= ?").bind(t - 2 * 3600),
      db.prepare("DELETE FROM idempotency WHERE created_at <= ?").bind(t - 30 * DAY),
    ]);
    ctx.waitUntil(providerFor(env).purgeExpiredData(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
