import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approvalFor, call, connectAgent, field, signIn, tool, twoPeopleInARoom } from "./helpers";
import { alnum, b64url } from "./scanner/fixtures";

const key = () => crypto.randomUUID();
const anthropicKey = () => ["sk-", "ant-", "api03-", b64url(93), "AA"].join("");

describe("secret check on every post", () => {
  it("holds a secret even when everyone is approved, names the rule and never echoes the value", async () => {
    const { a, alice, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const secret = anthropicKey();
    const r = await tool(a, "send_message", { room_id: roomId, body: `use this: ${secret}`, idempotency_key: key() });
    expect(r.structuredContent).toMatchObject({ status: "pending_approval", reason: "possible_secret", rules: ["anthropic-api-key"] });
    expect(r.text).toMatch(/rule: anthropic-api-key/);
    expect(r.text).toMatch(/Do not retry, rephrase, split or encode it/);
    expect(JSON.stringify(r)).not.toContain(secret.slice(10, 40));
    const postId = r.structuredContent!.post_id as string;

    // Nothing that is logged or sent carries the value.
    const audit = await env.DB.prepare("SELECT detail FROM audit WHERE target = ?").bind(postId).first<{ detail: string }>();
    expect(audit!.detail).toMatch(/^possible_secret anthropic-api-key:[A-Za-z0-9_-]{16}$/);
    const notice = await env.DB.prepare("SELECT subject, text FROM notices WHERE kind = 'held' AND person_id = (SELECT author_id FROM posts WHERE id = ?)").bind(postId).first<{ subject: string; text: string }>();
    expect(notice!.text).toContain("anthropic-api-key");
    expect(notice!.text + notice!.subject).not.toContain(secret.slice(10, 40));

    // The review page masks it, offers Release once and Reject only, and keeps the full text behind Reveal.
    const page = await alice.html(`/app/held/${postId}`);
    expect(page).toContain("It looks like it contains a secret.");
    expect(page).toMatch(new RegExp(`<mark[^>]*>sk-ant•+${secret.slice(-4)}</mark>`));
    expect(page.split("<details")[0]).not.toContain(secret.slice(10, 40));
    expect(page).toContain("Release once");
    expect(page).not.toContain('value="release_trust"');
    expect(page).toContain("<summary>Reveal the full text</summary>");

    // Trust cannot be forced through the API either.
    const forged = await alice.post(`/app/held/${postId}`, { csrf: field(page, "csrf"), approval_id: approvalFor(page, "release"), decision: "release_trust" });
    expect(forged.headers.get("location")).toContain("changed=approval_invalid");

    // Release once publishes exactly the body.
    const res = await alice.post(`/app/held/${postId}`, { csrf: field(page, "csrf"), approval_id: approvalFor(page, "release"), decision: "release" });
    expect(res.status).toBe(303);
    expect((await tool(a, "get_post", { post_id: postId })).structuredContent!.status).toBe("published");
  });

  it("catches a secret split across two posts from different connections of the same person", async () => {
    const { a, alice, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const other = await connectAgent(alice, { clientName: "Second agent" });
    const secret = ["sk", "_live_", alnum(24)].join("");
    const first = await tool(a, "send_message", { room_id: roomId, body: `part one ${secret.slice(0, 14)}`, idempotency_key: key() });
    expect(first.structuredContent!.status).toBe("published");
    const second = await tool(other, "send_message", { room_id: roomId, body: `${secret.slice(14)} part two`, idempotency_key: key() });
    expect(second.structuredContent).toMatchObject({ status: "pending_approval", reason: "possible_secret", rules: ["stripe-secret-key"] });
    const page = await alice.html(`/app/held/${second.structuredContent!.post_id}`);
    expect(page).toContain("earlier posts that the match spans");
    expect(page).toContain(`#${first.structuredContent!.seq}`);
  });

  it("catches encoded and disguised secrets", async () => {
    const { a, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const secret = anthropicKey();
    for (const body of [btoa(`KEY=${secret}`), [...secret].join("​"), [...secret].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")]) {
      const r = await tool(a, "send_message", { room_id: roomId, body, idempotency_key: key() });
      expect(r.structuredContent!.reason, body.slice(0, 20)).toBe("possible_secret");
      await tool(a, "cancel_held_post", { post_id: r.structuredContent!.post_id });
    }
  });

  it("only the author's person sees a held post: not the other member, by any path", async () => {
    const { a, b, bob, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const secret = anthropicKey();
    const r = await tool(a, "send_message", { room_id: roomId, body: `here ${secret}`, idempotency_key: key() });
    const postId = r.structuredContent!.post_id as string;
    const who = await tool(b, "whoami");
    expect(who.structuredContent!.held_posts).toBe(0);
    const rooms = await tool(b, "list_rooms");
    expect(rooms.structuredContent!.rooms[0].your_held_posts).toBe(0);
    const read = await tool(b, "read_room", { room_id: roomId });
    expect(read.text).not.toContain(secret.slice(10, 30));
    expect(read.structuredContent!.your_held_posts).toEqual([]);
    expect((await tool(b, "get_post", { post_id: postId })).code).toBe("not_found");
    expect((await bob.get(`/app/held/${postId}`)).status).toBe(404);
    expect(await bob.html("/app")).not.toContain(postId);
    expect(await bob.html(`/app/rooms/${roomId}`)).not.toContain(secret.slice(10, 30));
    const bobNotices = await env.DB.prepare("SELECT count(*) AS n FROM notices WHERE person_id = (SELECT person_id FROM memberships WHERE room_id = ? AND person_id != (SELECT author_id FROM posts WHERE id = ?))")
      .bind(roomId, postId)
      .first<{ n: number }>();
    expect(bobNotices!.n).toBe(0);
  });

  it("rejecting, cancelling or expiring a hold deletes its body but get_post still answers", async () => {
    const { a, alice, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const r1 = await tool(a, "send_message", { room_id: roomId, body: `one ${anthropicKey()}`, idempotency_key: key() });
    const p1 = r1.structuredContent!.post_id as string;
    const page = await alice.html(`/app/held/${p1}`);
    await alice.post(`/app/held/${p1}`, { csrf: field(page, "csrf"), approval_id: approvalFor(page, "reject"), decision: "reject", note: "never post keys" });
    const r2 = await tool(a, "send_message", { room_id: roomId, body: `two ${anthropicKey()}`, idempotency_key: key() });
    const p2 = r2.structuredContent!.post_id as string;
    await tool(a, "cancel_held_post", { post_id: p2 });
    const r3k = key();
    const r3 = await tool(a, "send_message", { room_id: roomId, body: `three ${anthropicKey()}`, idempotency_key: r3k });
    const p3 = r3.structuredContent!.post_id as string;
    await env.DB.prepare("UPDATE posts SET created_at = created_at - 86401 WHERE id = ?").bind(p3).run();
    expect((await tool(a, "get_post", { post_id: p3 })).structuredContent!.status).toBe("expired");
    for (const [id, status] of [[p1, "rejected"], [p2, "cancelled"], [p3, "expired"]] as const) {
      const row = await env.DB.prepare("SELECT body, status FROM posts WHERE id = ?").bind(id).first<{ body: string; status: string }>();
      expect(row).toEqual({ body: "", status });
      expect((await tool(a, "get_post", { post_id: id })).structuredContent!.status).toBe(status);
    }
  });

  it("an idempotent retry reports the existing post's terminal status, even after expiry", async () => {
    const { b, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const k = key();
    const body = "needs review";
    const first = await tool(b, "send_message", { room_id: roomId, body, idempotency_key: k });
    expect(first.structuredContent!.status).toBe("pending_approval");
    await env.DB.prepare("UPDATE posts SET created_at = created_at - 86401 WHERE id = ?").bind(first.structuredContent!.post_id).run();
    const retry = await tool(b, "send_message", { room_id: roomId, body, idempotency_key: k });
    expect(retry.isError).toBeFalsy();
    expect(retry.structuredContent).toMatchObject({ status: "expired", post_id: first.structuredContent!.post_id, replayed: true });
  });

  it("refuses a room title or purpose that looks like a secret, without echoing it", async () => {
    const alice = await signIn("meta@alpha.example");
    const a = await connectAgent(alice);
    const secret = anthropicKey();
    for (const args of [{ title: `keys ${secret}`, purpose: "" }, { title: "ok", purpose: `DB_PASSWORD=${alnum(10)}!${alnum(10)}` }]) {
      const r = await tool(a, "create_room", args);
      expect(r.code).toBe("possible_secret");
      expect(r.text).not.toContain(secret.slice(10, 30));
    }
    const rooms = await env.DB.prepare("SELECT count(*) AS n FROM rooms WHERE creator_id = (SELECT person_id FROM connections WHERE id = ?)").bind(a.connectionId).first<{ n: number }>();
    expect(rooms!.n).toBe(0);
  });

  it("refuses a connection label that looks like a secret", async () => {
    const alice = await signIn("label@alpha.example");
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.7.7.7" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:4000/cb"], client_name: "x", token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://127.0.0.1:4000/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
    const consent = await alice.html(`/authorize?${q}`);
    const res = await alice.post("/consent", {
      csrf: field(consent, "csrf"),
      approval_id: field(consent, "approval_id"),
      label: ["npm", "_", alnum(36)].join(""),
      trust: "gated",
      decision: "approve",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose another label");
    const n = await env.DB.prepare("SELECT count(*) AS n FROM connections WHERE client_id = ?").bind(client_id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("hold every post", () => {
  it("holds every post in the room for its owner, approved or not; turning it off needs a fresh sign-in", async () => {
    const { a, alice, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const roomPage = await alice.html(`/app/rooms/${roomId}`);
    await alice.post(`/app/rooms/${roomId}/hold-every-post`, { csrf: field(roomPage, "csrf"), on: "1" });
    const r = await tool(a, "send_message", { room_id: roomId, body: "plain update", idempotency_key: key() });
    expect(r.structuredContent).toMatchObject({ status: "pending_approval", reason: "hold_every_post" });
    const page = await alice.html(`/app/held/${r.structuredContent!.post_id}`);
    expect(page).toContain("You turned on Hold every post");
    expect(page).not.toContain('value="release_trust"');
    await env.DB.prepare("UPDATE web_sessions SET auth_time = auth_time - 3600").run();
    const off = await alice.post(`/app/rooms/${roomId}/hold-every-post`, { csrf: field(roomPage, "csrf"), on: "0" });
    expect(off.status).toBe(403);
  });
});

describe("review fixes", () => {
  it("'Stop in every room' removes allowlist trust so posts wait again", async () => {
    const { b, bob, roomId, suffix } = await twoPeopleInARoom();
    const req = await tool(b, "request_allowlist_entry", { room_id: roomId, person: `alice-${suffix}@alpha.example`, scope: "everywhere" });
    const dash = await bob.html("/app");
    await bob.post(`/app/requests/${req.structuredContent!.request_id}`, { csrf: field(dash, "csrf"), approval_id: approvalFor(dash, "approve"), decision: "approve" });
    expect((await tool(b, "send_message", { room_id: roomId, body: "trusted", idempotency_key: key() })).structuredContent!.status).toBe("published");
    const roomPage = await bob.html(`/app/rooms/${roomId}`);
    expect(roomPage).toContain("trusted in every room");
    const aliceId = (await env.DB.prepare("SELECT id FROM people WHERE email = ?").bind(`alice-${suffix}@alpha.example`).first<{ id: string }>())!.id;
    await bob.post(`/app/rooms/${roomId}/allowlist/${aliceId}/remove`, { csrf: field(roomPage, "csrf") });
    expect((await tool(b, "send_message", { room_id: roomId, body: "after stop", idempotency_key: key() })).structuredContent!.status).toBe("pending_approval");
  });

  it("the one-held-post rule holds inside the transaction", async () => {
    const { b, roomId } = await twoPeopleInARoom();
    const first = await tool(b, "send_message", { room_id: roomId, body: "first", idempotency_key: key() });
    // Pretend the pre-check missed it (as in a race) by hiding it from the time filter.
    await env.DB.prepare("UPDATE posts SET created_at = created_at - 86000 WHERE id = ?").bind(first.structuredContent!.post_id).run();
    const second = await tool(b, "send_message", { room_id: roomId, body: "second", idempotency_key: key() });
    expect(second.structuredContent!.status).toBe("blocked_by_held");
  });

  it("an approval posted to another object's URL is refused", async () => {
    const { b, bob, roomId } = await twoPeopleInARoom();
    const one = await tool(b, "send_message", { room_id: roomId, body: "one", idempotency_key: key() });
    const page = await bob.html(`/app/held/${one.structuredContent!.post_id}`);
    const res = await bob.post(`/app/held/post_other`, { csrf: field(page, "csrf"), approval_id: approvalFor(page, "release"), decision: "release" });
    expect(res.headers.get("location")).toContain("changed=approval_invalid");
    expect((await tool(b, "get_post", { post_id: one.structuredContent!.post_id })).structuredContent!.status).toBe("held");
  });

  it("pages that refresh reuse their approval records", async () => {
    const { b, bob, roomId } = await twoPeopleInARoom();
    const one = await tool(b, "send_message", { room_id: roomId, body: "one", idempotency_key: key() });
    const p1 = await bob.html(`/app/held/${one.structuredContent!.post_id}`);
    const p2 = await bob.html(`/app/held/${one.structuredContent!.post_id}`);
    expect(approvalFor(p2, "release")).toBe(approvalFor(p1, "release"));
  });

  it("return_to cannot leave the site, even with tabs or backslashes", async () => {
    const { safeReturnTo } = await import("../src/web/session");
    for (const bad of ["/\t/evil.example", "//evil.example", "/\\evil.example", "/%09/evil.example".replace("%09", "\t"), "https://evil.example", "/\n/evil"]) {
      expect(safeReturnTo(bad), JSON.stringify(bad)).toBe("/app");
    }
    expect(safeReturnTo("/app/held/post_1?x=1")).toBe("/app/held/post_1?x=1");
  });

  it("/authorize sends anonymous visitors to sign in before looking at the client", async () => {
    const q = new URLSearchParams({ response_type: "code", client_id: "https://unreachable.invalid/client.json", redirect_uri: "http://127.0.0.1:1/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
    const res = await call(`/authorize?${q}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/auth\/login\?return_to=/);
  });

  it("an invitee already at the room cap cannot accept another invite", async () => {
    const { acceptInvite, confirmInvite } = await import("./helpers");
    const alice = await signIn("cap-alice@alpha.example");
    const a = await connectAgent(alice);
    const room = await tool(a, "create_room", { title: "R", purpose: "" });
    const inv = await tool(a, "propose_invite", { room_id: room.structuredContent!.room_id, email: "cap-bob@beta.example" });
    const link = await confirmInvite(alice, inv.structuredContent!.invite_id, false);
    const bob = await signIn("cap-bob@beta.example");
    const bobId = (await env.DB.prepare("SELECT id FROM people WHERE email = 'cap-bob@beta.example'").first<{ id: string }>())!.id;
    const t = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (let i = 0; i < 50; i++) {
      stmts.push(env.DB.prepare("INSERT INTO rooms (id, title, purpose, history_mode, creator_id, created_at) VALUES (?, 'x', '', 'from_join', ?, ?)").bind(`room_cap${i}`, bobId, t));
      stmts.push(env.DB.prepare("INSERT INTO memberships (room_id, person_id, visibility_floor, joined_at) VALUES (?, ?, 1, ?)").bind(`room_cap${i}`, bobId, t));
    }
    await env.DB.batch(stmts);
    const page = await bob.html(link);
    const res = await bob.post(link, { csrf: field(page, "csrf"), approval_id: field(page, "approval_id"), decision: "accept" });
    expect(res.status).toBe(400);
    void acceptInvite;
  });
});
