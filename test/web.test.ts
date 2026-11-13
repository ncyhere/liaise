import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { Browser, call, field, ORIGIN, signIn } from "./helpers";

describe("web security", () => {
  it("pages refuse framing and carry a strict CSP", async () => {
    const alice = await signIn("hdr@alpha.example");
    const res = await alice.get("/app");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("state-changing requests need the CSRF token and the exact Origin", async () => {
    const alice = await signIn("csrf@alpha.example");
    const dash = await alice.html("/app");
    const csrf = field(dash, "csrf");
    expect((await alice.post("/app/pause", { paused: "1" })).status).toBe(403);
    expect((await alice.post("/app/pause", { csrf: "wrong", paused: "1" })).status).toBe(403);
    expect((await alice.post("/app/pause", { csrf, paused: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await alice.post("/app/pause", { csrf, paused: "1" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const paused = await env.DB.prepare("SELECT paused FROM people WHERE email = 'csrf@alpha.example'").first<{ paused: number }>();
    expect(paused!.paused).toBe(0);
    expect((await alice.post("/app/pause", { csrf, paused: "1" })).status).toBe(303);
  });

  it("everything a person wrote is escaped on the page", async () => {
    const alice = await signIn("esc@alpha.example", "<img src=x onerror=alert(1)>");
    const html = await alice.html("/app");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("the consent page names the client as unverified, warns about loopback and allows only its redirect", async () => {
    const alice = await signIn("consent@alpha.example");
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.9" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:4567/cb"], client_name: "Totally Claude", token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:4567/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
    const res = await alice.get(`/authorize?${q}`);
    const html = await res.text();
    expect(html).toContain("name not verified");
    expect(html).toContain("This address is on your own computer");
    expect(html).toContain("http://localhost:4567/cb");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:4567");
  });

  it("a stale sign-in must sign in again before approving a new client", async () => {
    const alice = await signIn("stale@alpha.example");
    await env.DB.prepare("UPDATE web_sessions SET auth_time = auth_time - 3600").run();
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.8" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:4567/cb"], client_name: "X", token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:4567/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
    const html = await alice.html(`/authorize?${q}`);
    expect(html).toContain("Sign in again to connect an agent");
    expect(html).not.toContain('name="approval_id"');
  });

  it("signed-out visitors are sent to sign in", async () => {
    const b = new Browser();
    const res = await b.get("/app/held/post_abc");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/login?return_to=%2Fapp%2Fheld%2Fpost_abc");
  });

  it("refuses to run with DEV_LOGIN on a public origin, and redirects other origins to the canonical one", async () => {
    const ctx = createExecutionContext();
    const bad = await worker.fetch(new Request("https://liaise.example.com/app"), { ...env, PUBLIC_ORIGIN: "https://liaise.example.com" }, ctx);
    expect(bad.status).toBe(500);
    expect(await bad.text()).toContain("DEV_LOGIN is set on a non-local origin");
    const other = await worker.fetch(new Request("http://127.0.0.1:8787/app"), env, ctx);
    expect(other.status).toBe(308);
    expect(other.headers.get("location")).toBe(`${ORIGIN}/app`);
  });

  it("dev sign-in does not exist without the flag", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/dev-login`), { ...env, DEV_LOGIN: undefined }, ctx);
    expect(res.status).toBe(404);
  });
});

describe("fresh sign-in for raising trust", () => {
  it("a stale session can release but not release-and-trust, nor confirm an invite with the opt-in", async () => {
    const { twoPeopleInARoom, tool, approvalFor } = await import("./helpers");
    const { b, bob, roomId } = await twoPeopleInARoom();
    const held = await tool(b, "send_message", { room_id: roomId, body: "stale check", idempotency_key: crypto.randomUUID() });
    const postId = held.structuredContent!.post_id as string;
    // Take a release-and-trust approval while fresh, then let the sign-in go stale.
    const freshPage = await bob.html(`/app/held/${postId}`);
    const trustApproval = approvalFor(freshPage, "release_trust");
    await env.DB.prepare("UPDATE web_sessions SET auth_time = auth_time - 3600").run();
    const stalePage = await bob.html(`/app/held/${postId}`);
    expect(stalePage).toContain("Sign in again to release and trust");
    expect(stalePage).not.toContain('value="release_trust"');
    const refused = await bob.post(`/app/held/${postId}`, { csrf: field(stalePage, "csrf"), approval_id: trustApproval, decision: "release_trust" });
    expect(refused.status).toBe(403);
    expect((await tool(b, "get_post", { post_id: postId })).structuredContent!.status).toBe("held");
    // Plain release still works.
    const ok = await bob.post(`/app/held/${postId}`, { csrf: field(stalePage, "csrf"), approval_id: approvalFor(stalePage, "release"), decision: "release" });
    expect(ok.status).toBe(303);
    expect((await tool(b, "get_post", { post_id: postId })).structuredContent!.status).toBe("published");
  });

  it("a stale inviter cannot confirm with the opt-in", async () => {
    const { connectAgent, tool } = await import("./helpers");
    const alice = await signIn("stale-inviter@alpha.example");
    const a = await connectAgent(alice);
    const room = await tool(a, "create_room", { title: "R", purpose: "" });
    const inv = await tool(a, "propose_invite", { room_id: room.structuredContent!.room_id, email: "x@beta.example" });
    const inviteId = inv.structuredContent!.invite_id as string;
    await env.DB.prepare("UPDATE web_sessions SET auth_time = auth_time - 3600").run();
    const page = await alice.html(`/app/invites/${inviteId}`);
    expect(page).not.toContain('name="grant"');
    const res = await alice.post(`/app/invites/${inviteId}/confirm`, { csrf: field(page, "csrf"), approval_id: field(page, "approval_id"), grant: "1" });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT status FROM invites WHERE id = ?").bind(inviteId).first<{ status: string }>();
    expect(row!.status).toBe("proposed");
  });
});

describe("Google sign-in freshness", () => {
  async function googleSignIn(fresh: boolean, claims: Record<string, unknown>): Promise<Response> {
    const { vi } = await import("vitest");
    const genv = { ...env, DEV_LOGIN: undefined, GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret" };
    const ctx = createExecutionContext();
    const start = await worker.fetch(new Request(`${ORIGIN}/auth/login?return_to=/app${fresh ? "&fresh=1" : ""}`), genv, ctx);
    const google = new URL(start.headers.get("location")!);
    expect(google.searchParams.get("max_age")).toBe(fresh ? "0" : null);
    const state = google.searchParams.get("state")!;
    const nonce = google.searchParams.get("nonce")!;
    const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: genv.GOOGLE_CLIENT_ID, exp: now + 600, nonce, sub: "g-123", email: "g@gamma.example", email_verified: true, ...claims })}.sig`;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id_token: idToken }), { headers: { "content-type": "application/json" } }));
    try {
      return await worker.fetch(new Request(`${ORIGIN}/auth/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { cookie } }), genv, ctx);
    } finally {
      spy.mockRestore();
    }
  }
  const sessionAuthTime = async () =>
    (await env.DB.prepare("SELECT s.auth_time FROM web_sessions s JOIN people p ON p.id = s.person_id WHERE p.subject = 'g-123' ORDER BY s.rowid DESC LIMIT 1").first<{ auth_time: number }>())!.auth_time;

  it("an ordinary sign-in without auth_time is not fresh", async () => {
    const res = await googleSignIn(false, {});
    expect(res.status).toBe(303);
    expect(await sessionAuthTime()).toBe(0);
  });

  it("'sign in again' refuses an old authentication and accepts a new one", async () => {
    const old = await googleSignIn(true, { auth_time: Math.floor(Date.now() / 1000) - 86400 });
    expect(old.status).toBe(400);
    const fresh = await googleSignIn(true, { auth_time: Math.floor(Date.now() / 1000) });
    expect(fresh.status).toBe(303);
    expect(Math.floor(Date.now() / 1000) - (await sessionAuthTime())).toBeLessThan(5);
  });
});
