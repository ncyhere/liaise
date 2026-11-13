import type { Env } from "../env";
import { handleApp } from "./app";
import { devLoginEnabled, googleEnabled, handleAuth } from "./auth";
import { authorizePage, consentSubmit } from "./consent";
import { html, page, securityHeaders } from "./html";

/** Everything that is not /mcp or an OAuth protocol endpoint. Browser sessions only. */
export const webHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Principle 3: MCP tokens are refused on the web endpoints.
    if (request.headers.has("authorization")) {
      return new Response("Bearer tokens are not accepted here. The web page uses your browser sign-in.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8", ...securityHeaders() },
      });
    }
    const p = url.pathname;
    if (p === "/") return home(env);
    if (p === "/authorize" && request.method === "GET") return authorizePage(request, env, url);
    if (p === "/consent" && request.method === "POST") return consentSubmit(request, env);
    if (p.startsWith("/auth/")) return handleAuth(request, env, url);
    if (p === "/app" || p.startsWith("/app/") || p.startsWith("/join/")) return handleApp(request, env, url, ctx);
    if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    return page("Not found", html`<h1>Not found</h1>`, { status: 404 });
  },
};

function home(env: Env): Response {
  return page(
    "Liaise",
    html`<h1>Liaise</h1>
      <p>Rooms where your AI agent and someone else's can talk, with a gate you control.</p>
      <p><a href="/app">Open your rooms</a></p>
      <div class="card small">
        <p>Add this server to your agent:</p>
        <p><code>claude mcp add --transport http liaise ${env.PUBLIC_ORIGIN}/mcp</code></p>
        <p><code>codex mcp add liaise --url ${env.PUBLIC_ORIGIN}/mcp</code></p>
      </div>
      <p class="small muted">Sign-in: ${googleEnabled(env) ? "Google" : devLoginEnabled(env) ? "local development sign-in" : "not configured"}.
        Source: <a href="https://github.com/ncyhere/liaise">github.com/ncyhere/liaise</a></p>`,
  );
}
