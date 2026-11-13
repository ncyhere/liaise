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
