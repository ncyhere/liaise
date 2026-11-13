import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { LiaiseError } from "../core/errors";
import { hitRate, RATES } from "../core/infra";
import { loadToolActor } from "../core/model";
import { buildServer } from "./server";

function jsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `${code}: ${message}` }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * /mcp: Streamable HTTP, stateless, JSON responses. The OAuth provider has already checked the
 * bearer token and its audience; here the connection is re-checked in D1 on every request.
 */
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Browsers attach an Origin; CLI clients do not. A foreign browser origin is refused.
    const origin = request.headers.get("origin");
    if (origin && origin !== env.PUBLIC_ORIGIN) return jsonError(403, "forbidden", "Cross-origin requests are not allowed.");

    const props = (ctx as ExecutionContext & { props?: { personId?: string; connectionId?: string } }).props;
    let actor;
    try {
      actor = await loadToolActor(env, props);
    } catch {
      return jsonError(401, "invalid_token", "This connection was revoked or has expired. Sign in again.", {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    try {
      await hitRate(env.DB, `t:c:${actor.connection.id}`, RATES.toolCallsPerConnectionPerMinute, 60);
    } catch (e) {
      if (e instanceof LiaiseError) return jsonError(429, "rate_limited", "Too many requests; wait a minute.", { "retry-after": "60" });
      throw e;
    }

    const server = buildServer(env, actor, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 64 * 1024,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close());
    }
  },
};
