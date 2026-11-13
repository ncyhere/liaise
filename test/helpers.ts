import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";

export const ORIGIN = "http://localhost:8787";

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(ORIGIN + path, { redirect: "manual", ...init }));
}

/** A scripted browser: keeps cookies, sends the same-origin headers a real browser would. */
export class Browser {
  cookies = new Map<string, string>();

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/i.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  }

  async get(path: string): Promise<Response> {
    const res = await call(path, { headers: this.cookieHeader() });
    this.store(res);
    return res;
  }

  async post(path: string, form: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
    const res = await call(path, {
      method: "POST",
      headers: {
        ...this.cookieHeader(),
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
        ...extra,
      },
      body: new URLSearchParams(form).toString(),
    });
    this.store(res);
    return res;
  }

  async html(path: string): Promise<string> {
    const res = await this.get(path);
    expect(res.status, `GET ${path}`).toBe(200);
    return res.text();
  }
}

export function field(html: string, name: string, nth = 0): string {
  const re = new RegExp(`name="${name}" value="([^"]*)"`, "g");
  const all = [...html.matchAll(re)].map((m) => m[1]!);
  if (all[nth] === undefined) throw new Error(`no field ${name}[${nth}] in page`);
  return all[nth]!;
}

/** The approval id inside the form whose hidden `decision` field has this value. */
export function approvalFor(html: string, decision: string): string {
  const re = new RegExp(`name="approval_id" value="([^"]+)">\\s*<input type="hidden" name="decision" value="${decision}"`);
  const m = re.exec(html);
  if (!m) throw new Error(`no ${decision} form in page`);
  return m[1]!;
}

export async function signIn(email: string, name = ""): Promise<Browser> {
  const b = new Browser();
  const res = await b.post("/auth/dev-login?return_to=/app", { email, name });
  expect(res.status).toBe(303);
  return b;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

export interface Agent {
  token: string;
  refresh: string;
  clientId: string;
  connectionId: string;
  browser: Browser;
}

/** Runs the real OAuth flow: dynamic registration, /authorize, consent, code exchange. */
export async function connectAgent(
  browser: Browser,
  opts: { clientName?: string; label?: string; trust?: "gated" | "read_only" } = {},
): Promise<Agent> {
  const redirectUri = "http://127.0.0.1:33418/callback";
  const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const reg = await call("/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: opts.clientName ?? "Test Agent",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    resource: `${ORIGIN}/mcp`,
  });
  const consent = await browser.html(`/authorize?${q}`);
  const res = await browser.post("/consent", {
    csrf: field(consent, "csrf"),
    approval_id: field(consent, "approval_id"),
    label: opts.label ?? "test agent",
    trust: opts.trust ?? "gated",
    decision: "approve",
  });
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.searchParams.get("state")).toBe("st8");
  const code = loc.searchParams.get("code")!;
  const tok = await call("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  expect(tok.status).toBe(200);
  const t = (await tok.json()) as { access_token: string; refresh_token: string };
  const conn = await env.DB.prepare("SELECT id FROM connections WHERE client_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(clientId)
    .first<{ id: string }>();
  return { token: t.access_token, refresh: t.refresh_token, clientId, connectionId: conn!.id, browser };
}

let rpcId = 1;

export async function mcpRaw(token: string, method: string, params: unknown = {}): Promise<Response> {
  return call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
  text: string;
  code?: string;
}

export async function tool(agent: Agent | string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const token = typeof agent === "string" ? agent : agent.token;
  const res = await mcpRaw(token, "tools/call", { name, arguments: args });
  expect(res.status, `${name} HTTP status`).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  if (!body.result) throw new Error(`no result: ${JSON.stringify(body)}`);
  const r = body.result;
  r.text = r.content.map((c) => c.text).join("\n");
  r.code = r.structuredContent?.error?.code;
  return r;
}

/** Two people with one agent each, sharing a confirmed room (A invited B). */
export async function twoPeopleInARoom(opts: { historyMode?: "from_join" | "full"; inviterGrant?: boolean } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await signIn(`alice-${suffix}@alpha.example`, "Alice");
  const bob = await signIn(`bob-${suffix}@beta.example`, "Bob");
  const a = await connectAgent(alice, { label: "Claude Code" });
  const b = await connectAgent(bob, { label: "Codex" });
  const room = await tool(a, "create_room", { title: "Inventory API", purpose: "Agree the contract", history_mode: opts.historyMode ?? "from_join" });
  const roomId = room.structuredContent!.room_id as string;
  const inv = await tool(a, "propose_invite", { room_id: roomId, email: `bob-${suffix}@beta.example` });
  const inviteId = inv.structuredContent!.invite_id as string;
  const link = await confirmInvite(alice, inviteId, opts.inviterGrant ?? true);
  await acceptInvite(bob, link);
  return { alice, bob, a, b, roomId, inviteId, suffix };
}

export async function confirmInvite(browser: Browser, inviteId: string, grant: boolean): Promise<string> {
  const page = await browser.html(`/app/invites/${inviteId}`);
  const form: Record<string, string> = { csrf: field(page, "csrf"), approval_id: field(page, "approval_id") };
  if (grant) form.grant = "1";
  const res = await browser.post(`/app/invites/${inviteId}/confirm`, form);
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = /<code>(http:\/\/localhost:8787\/join\/[^<]+)<\/code>/.exec(html);
  if (!m) throw new Error("no invite link on page");
  return m[1]!.replace(ORIGIN, "");
}

export async function acceptInvite(browser: Browser, path: string, grant = false): Promise<Response> {
  const page = await browser.html(path);
  const form: Record<string, string> = { csrf: field(page, "csrf"), approval_id: field(page, "approval_id"), decision: "accept" };
  if (grant) form.grant = "1";
  const res = await browser.post(path, form);
  expect(res.status).toBe(303);
  return res;
}

/** Opens the review page for a held post and submits one decision. */
export async function decide(browser: Browser, postId: string, decision: "release" | "release_trust" | "reject", note = ""): Promise<Response> {
  const page = await browser.html(`/app/held/${postId}`);
  return browser.post(`/app/held/${postId}`, {
    csrf: field(page, "csrf"),
    approval_id: approvalFor(page, decision),
    decision,
    note,
  });
}
