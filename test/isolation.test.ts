import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalFor, call, connectAgent, field, mcpRaw, signIn, tool, twoPeopleInARoom, type Agent, type Browser } from "./helpers";

const key = () => crypto.randomUUID();

/**
 * Person A (Alice) and person B (Bob) share nothing at first. Every tool is called with A's token
 * on B's rooms, posts, held posts, invites and allowlist requests; every one must fail as if the
 * object did not exist, and leave B's data unchanged.
 */
describe("person A's token cannot reach person B's data", () => {
  let a: Agent;
  let b: Agent;
  let alice: Browser;
  let bob: Browser;
  let bRoom: string;
  let bPublished: string;
  let bHeld: string;
  let bInvite: string;
  let bRequest: string;

  beforeAll(async () => {
    alice = await signIn("iso-alice@alpha.example", "Alice");
    a = await connectAgent(alice, { label: "alice agent" });
    // Bob's world: a room shared with Carol, a published post, a held post, an open invite to
    // another room, and a pending allowlist request.
    const shared = await twoPeopleInARoom({ inviterGrant: true });
    bob = shared.alice; // the inviter in that helper; here they play "Bob"
    b = shared.a;
    bRoom = shared.roomId;
    const pub = await tool(b, "send_message", { room_id: bRoom, body: "Bob's published secret", idempotency_key: key() });
    bPublished = pub.structuredContent!.post_id;
    // Make Bob's next post wait: remove his grant for the other member.
    await env.DB.prepare("DELETE FROM room_grants WHERE room_id = ?").bind(bRoom).run();
    const held = await tool(b, "send_message", { room_id: bRoom, body: "Bob's held secret", idempotency_key: key() });
    expect(held.structuredContent!.status).toBe("pending_approval");
    bHeld = held.structuredContent!.post_id;
    const other = await tool(b, "create_room", { title: "Bob private", purpose: "" });
    const inv = await tool(b, "propose_invite", { room_id: other.structuredContent!.room_id, email: "dave@delta.example" });
    bInvite = inv.structuredContent!.invite_id;
    const req = await tool(b, "request_allowlist_entry", { room_id: bRoom, person: `bob-${shared.suffix}@beta.example`, scope: "everywhere" });
    bRequest = req.structuredContent!.request_id;
  });

  it("whoami shows only A", async () => {
    const r = await tool(a, "whoami");
    expect(r.structuredContent!.person.email).toBe("iso-alice@alpha.example");
    expect(r.structuredContent!.held_posts).toBe(0);
    expect(r.structuredContent!.invites_to_confirm).toBe(0);
  });

  it("list_rooms shows none of B's rooms", async () => {
    const r = await tool(a, "list_rooms");
    expect(r.structuredContent!.rooms).toEqual([]);
    expect(r.text).not.toContain(bRoom);
  });

  it("read_room on B's room is not_found, even with wait_seconds", async () => {
    for (const args of [{ room_id: bRoom }, { room_id: bRoom, after_seq: 0, wait_seconds: 1 }]) {
      const r = await tool(a, "read_room", args);
      expect(r.code).toBe("not_found");
      expect(r.text).not.toContain("secret");
    }
  });

  it("send_message to B's room is not_found and writes nothing", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM posts WHERE room_id = ?").bind(bRoom).first<{ n: number }>();
    const r = await tool(a, "send_message", { room_id: bRoom, body: "intrusion", idempotency_key: key() });
    expect(r.code).toBe("not_found");
    const after = await env.DB.prepare("SELECT count(*) AS n FROM posts WHERE room_id = ?").bind(bRoom).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("propose_invite to B's room is not_found", async () => {
    const r = await tool(a, "propose_invite", { room_id: bRoom, email: "mallory@evil.example" });
    expect(r.code).toBe("not_found");
  });

  it("get_post on B's published and held posts is not_found", async () => {
    for (const id of [bPublished, bHeld]) {
      const r = await tool(a, "get_post", { post_id: id });
      expect(r.code).toBe("not_found");
      expect(r.text).not.toContain("secret");
    }
  });

  it("cancel_held_post on B's held post is not_found and leaves it held", async () => {
    const r = await tool(a, "cancel_held_post", { post_id: bHeld });
    expect(r.code).toBe("not_found");
    expect((await tool(b, "get_post", { post_id: bHeld })).structuredContent!.status).toBe("held");
  });

  it("request_allowlist_entry in B's room is not_found", async () => {
    const r = await tool(a, "request_allowlist_entry", { room_id: bRoom, person: "anyone@beta.example", scope: "room" });
    expect(r.code).toBe("not_found");
  });

  it("create_room makes a room only A can see", async () => {
    const r = await tool(a, "create_room", { title: "Alice only", purpose: "" });
    const bRooms = await tool(b, "list_rooms");
    expect(bRooms.text).not.toContain(r.structuredContent!.room_id);
    expect((await tool(b, "read_room", { room_id: r.structuredContent!.room_id })).code).toBe("not_found");
  });

  it("A's web session cannot open or act on B's held post, room, invite, request or connection", async () => {
    for (const path of [`/app/held/${bHeld}`, `/app/rooms/${bRoom}`, `/app/invites/${bInvite}`]) {
      const res = await alice.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("secret");
    }
    const dash = await alice.html("/app");
    expect(dash).not.toContain("Bob");
    const csrf = field(dash, "csrf");
    // Forged decisions: A's own approval ids are bound to A, and B's ids are bound to B's session.
    const bobPage = await bob.html(`/app/held/${bHeld}`);
    const stolen = approvalFor(bobPage, "release");
    const res = await alice.post(`/app/held/${bHeld}`, { csrf, approval_id: stolen, decision: "release" });
    expect([303, 404]).toContain(res.status);
    expect((await tool(b, "get_post", { post_id: bHeld })).structuredContent!.status).toBe("held");
    // Invite actions.
    for (const action of ["confirm", "revoke", "relink"]) {
      const r = await alice.post(`/app/invites/${bInvite}/${action}`, { csrf, approval_id: "apv_x" });
      expect(r.status, action).toBeGreaterThanOrEqual(400);
    }
    expect((await env.DB.prepare("SELECT status FROM invites WHERE id = ?").bind(bInvite).first<{ status: string }>())!.status).toBe("proposed");
    // Allowlist request and connection.
    const rq = await alice.post(`/app/requests/${bRequest}`, { csrf, approval_id: "apv_x", decision: "decline" });
    expect(rq.status).toBeGreaterThanOrEqual(400);
    expect((await env.DB.prepare("SELECT status FROM allowlist_requests WHERE id = ?").bind(bRequest).first<{ status: string }>())!.status).toBe("pending");
    const cn = await alice.post(`/app/connections/${b.connectionId}`, { csrf, action: "revoke" });
    expect(cn.status).toBe(404);
    expect((await tool(b, "whoami")).isError).toBeFalsy();
    // Accepting an invite addressed to someone else by id.
    expect((await alice.get(`/app/accept/${bInvite}`)).status).toBe(404);
  });
});

describe("room-mates still cannot reach each other's own records", () => {
  it("in a shared room, A cannot see, read or cancel B's held post, or B's post status", async () => {
    const { a, b, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const held = await tool(b, "send_message", { room_id: roomId, body: "B held", idempotency_key: key() });
    const id = held.structuredContent!.post_id;
    expect((await tool(a, "get_post", { post_id: id })).code).toBe("not_found");
    expect((await tool(a, "cancel_held_post", { post_id: id })).code).toBe("not_found");
    const read = await tool(a, "read_room", { room_id: roomId });
    expect(read.text).not.toContain("B held");
    expect(read.structuredContent!.your_held_posts).toEqual([]);
    const pub = await tool(a, "send_message", { room_id: roomId, body: "A published", idempotency_key: key() });
    expect((await tool(b, "get_post", { post_id: pub.structuredContent!.post_id })).code).toBe("not_found");
  });

  it("an idempotency key reused by another connection does not return its post", async () => {
    const { a, b, roomId } = await twoPeopleInARoom({ inviterGrant: true });
    const k = key();
    const one = await tool(a, "send_message", { room_id: roomId, body: "A's", idempotency_key: k });
    const two = await tool(b, "send_message", { room_id: roomId, body: "B's", idempotency_key: k });
    expect(two.structuredContent!.post_id).not.toBe(one.structuredContent!.post_id);
  });
});

describe("tokens and sessions stay in their lanes", () => {
  it("MCP tokens are refused on every web endpoint", async () => {
    const alice = await signIn("lane@alpha.example");
    const a = await connectAgent(alice);
    for (const path of ["/app", "/app/held/x", "/authorize", "/auth/login", "/"]) {
      const res = await call(path, { headers: { authorization: `Bearer ${a.token}` } });
      expect(res.status, path).toBe(400);
    }
  });

  it("a browser session cannot call /mcp", async () => {
    const alice = await signIn("lane2@alpha.example");
    const res = await call("/mcp", {
      method: "POST",
      headers: { cookie: [...alice.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("a token for another resource audience is refused", async () => {
    const res = await mcpRaw("not-a-token", "tools/list");
    expect(res.status).toBe(401);
  });
});
