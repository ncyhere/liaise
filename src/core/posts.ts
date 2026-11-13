import type { Env } from "../env";
import { assertStmt, fail, LiaiseError, runBatch, stmt } from "./errors";
import { auditStmt, hitWriteRates, sendNotice } from "./infra";
import { CONNECTION_ACTIVE_SQL, LIMITS, loadToolActor, type PostRow, type ToolActor } from "./model";
import { COVERED_SQL, membersOf, roomForMember, type Member } from "./rooms";
import { byteLength, newId, now, oneLine, sha256, stripInvisible } from "./util";

export type SendStatus = "published" | "pending_approval" | "blocked_by_held";
export type PostStatus = "held" | "published" | "rejected" | "cancelled" | "expired";

export interface SendResult {
  status: SendStatus;
  post_id: string | null;
  room_id: string;
  seq: number | null;
  review_url: string | null;
  held_post_id: string | null;
  replayed: boolean;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{1,128}$/;

export function reviewUrl(env: Env, postId: string): string {
  return `${env.PUBLIC_ORIGIN}/app/held/${postId}`;
}

/** SQL that expires the author's stale held post in a room. Parameters: ?1 author, ?3 now, ?4 room. */
const EXPIRE_STALE_HELD_SQL = `UPDATE posts SET status = 'expired', decided_at = ?3
  WHERE room_id = ?4 AND author_id = ?1 AND status = 'held' AND created_at <= ?3 - ${LIMITS.heldPostTtl}`;

export async function sendMessage(
  env: Env,
  actor: ToolActor,
  input: { room_id: string; body: string; idempotency_key: string; reply_to?: number },
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<SendResult> {
  if (actor.connection.trust === "read_only") fail("read_only");
  const body = stripInvisible(input.body).replace(/^\n+|\s+$/g, "");
  if (!body.trim()) fail("invalid_input", "The message body is empty.");
  if (byteLength(body) > LIMITS.messageBytes) fail("too_large", `Messages are limited to ${LIMITS.messageBytes} bytes.`);
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotency_key)) {
    fail("invalid_input", "idempotency_key must be 1-128 characters of letters, digits and . _ : -");
  }

  const db = env.DB;
  const { room, floor } = await roomForMember(db, actor.person.id, input.room_id);
  if (input.reply_to !== undefined) {
    if (!Number.isInteger(input.reply_to) || input.reply_to < floor || input.reply_to >= room.next_seq) {
      fail("invalid_input", "reply_to must be the number of a message you can see in this room.");
    }
  }
  const bodyHash = await sha256(body);

  // A retry with the same key returns the existing post's current status.
  const existing = await db
    .prepare("SELECT body_hash, post_id FROM idempotency WHERE connection_id = ? AND room_id = ? AND key = ?")
    .bind(actor.connection.id, room.id, input.idempotency_key)
    .first<{ body_hash: string; post_id: string }>();
  if (existing) return replay(env, existing, bodyHash, room.id);

  const t = now();
  // One held post per person per room: further sends are refused, not queued.
  const held = await db
    .prepare(
      `SELECT id FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held' AND created_at > ?`,
    )
    .bind(room.id, actor.person.id, t - LIMITS.heldPostTtl)
    .first<{ id: string }>();
  if (held) {
    return { status: "blocked_by_held", post_id: null, room_id: room.id, seq: null, review_url: reviewUrl(env, held.id), held_post_id: held.id, replayed: false };
  }

  await hitWriteRates(db, actor.person.id, actor.connection.id);

  const postId = newId("post");
  // Bind order shared by every statement below: ?1 author, ?2 connection, ?3 now, ?4 room.
  const base = [actor.person.id, actor.connection.id, t, room.id] as const;
  try {
    await runBatch(db, [
      stmt(db, EXPIRE_STALE_HELD_SQL, base),
      assertStmt(db, CONNECTION_ACTIVE_SQL, "connection_inactive", ...base),
      assertStmt(
        db,
        "EXISTS (SELECT 1 FROM connections WHERE id = ?2 AND trust = 'gated')",
        "read_only",
        ...base,
      ),
      assertStmt(
        db,
        "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)",
        "not_found",
        ...base,
      ),
      // The publish-or-hold decision is made here, inside the transaction that writes the post.
      stmt(
          db,
          `INSERT INTO posts (id, room_id, kind, author_id, connection_id, connection_label, body, body_hash, reply_to,
                              status, seq, membership_version, created_at, published_at)
           SELECT ?5, r.id, 'message', ?1, ?2, ?6, ?7, ?8, ?9,
                  CASE WHEN ${COVERED_SQL} THEN 'published' ELSE 'held' END,
                  CASE WHEN ${COVERED_SQL} THEN r.next_seq ELSE NULL END,
                  r.membership_version, ?3,
                  CASE WHEN ${COVERED_SQL} THEN ?3 ELSE NULL END
             FROM rooms r WHERE r.id = ?4`,
          [...base, postId, actor.connection.label, body, bodyHash, input.reply_to ?? null],
        ),
      stmt(
          db,
          "UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?4 AND EXISTS (SELECT 1 FROM posts WHERE id = ?5 AND status = 'published')",
          [...base, postId],
        ),
      stmt(
          db,
          "INSERT INTO idempotency (connection_id, room_id, key, body_hash, post_id, created_at) VALUES (?2, ?4, ?5, ?6, ?7, ?3)",
          [...base, input.idempotency_key, bodyHash, postId],
        ),
      auditStmt(db, { person: actor.person.id, connection: actor.connection.id, action: "post.send", room: room.id, target: postId }),
    ]);
  } catch (e) {
    if (e instanceof LiaiseError && e.code === "conflict") {
      // Lost a race: either the same idempotency key, or another held post just landed.
      const again = await db
        .prepare("SELECT body_hash, post_id FROM idempotency WHERE connection_id = ? AND room_id = ? AND key = ?")
        .bind(actor.connection.id, room.id, input.idempotency_key)
        .first<{ body_hash: string; post_id: string }>();
      if (again) return replay(env, again, bodyHash, room.id);
      const nowHeld = await db
        .prepare("SELECT id FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held'")
        .bind(room.id, actor.person.id)
        .first<{ id: string }>();
      if (nowHeld) {
        return { status: "blocked_by_held", post_id: null, room_id: room.id, seq: null, review_url: reviewUrl(env, nowHeld.id), held_post_id: nowHeld.id, replayed: false };
      }
    }
    throw e;
  }

  const post = await db.prepare("SELECT status, seq FROM posts WHERE id = ?").bind(postId).first<{ status: PostStatus; seq: number | null }>();
  if (!post) fail("internal");
  if (post.status === "held") {
    const notice = sendNotice(env, {
      personId: actor.person.id,
      email: actor.person.email,
      kind: "held",
      roomId: room.id,
      count: 1,
      subject: `Liaise: a post is waiting for you in "${oneLine(room.title, 60)}"`,
      text:
        `One post from your agent (${actor.connection.label}) is waiting for your review in the room ` +
        `"${oneLine(room.title, 80)}". Nobody else can see it until you release it.\n\n` +
        `Review it: ${reviewUrl(env, postId)}\n`,
    });
    if (ctx) ctx.waitUntil(notice);
    else await notice;
    return { status: "pending_approval", post_id: postId, room_id: room.id, seq: null, review_url: reviewUrl(env, postId), held_post_id: postId, replayed: false };
  }
  return { status: "published", post_id: postId, room_id: room.id, seq: post.seq, review_url: null, held_post_id: null, replayed: false };
}

async function replay(env: Env, existing: { body_hash: string; post_id: string }, bodyHash: string, roomId: string): Promise<SendResult> {
  if (existing.body_hash !== bodyHash) fail("idempotency_conflict");
  const post = await env.DB.prepare("SELECT status, seq FROM posts WHERE id = ?")
    .bind(existing.post_id)
    .first<{ status: PostStatus; seq: number | null }>();
  if (!post) fail("internal");
  const status: SendStatus = post.status === "published" ? "published" : "pending_approval";
  if (post.status !== "published" && post.status !== "held") {
    // Rejected, cancelled or expired: report it through get_post rather than pretending it waits.
    fail("invalid_input", `That post was ${post.status}. Use get_post with post_id ${existing.post_id} for details.`);
  }
  return {
    status,
    post_id: existing.post_id,
    room_id: roomId,
    seq: post.seq,
    review_url: status === "pending_approval" ? reviewUrl(env, existing.post_id) : null,
    held_post_id: status === "pending_approval" ? existing.post_id : null,
    replayed: true,
  };
}

// ---------- reading ----------

export interface VisibleMessage {
  seq: number;
  kind: "message" | "system";
  post_id: string;
  author_id: string | null;
  author_email: string | null;
  author_name: string | null;
  connection_label: string | null;
  body: string;
  reply_to: number | null;
  published_at: number;
}

export interface ReadResult {
  room_id: string;
  room_title: string;
  messages: VisibleMessage[];
  next_after_seq: number;
  has_more: boolean;
  your_held_posts: { post_id: string; body: string; created_at: number; review_url: string }[];
  waiting_on: string | null;
  members: Member[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Published posts visible to the person, after `afterSeq`, never below their visibility floor. */
export async function visibleMessages(
  db: D1Database,
  roomId: string,
  floor: number,
  afterSeq: number,
  limit: number,
): Promise<{ messages: VisibleMessage[]; hasMore: boolean }> {
  const from = Math.max(afterSeq, floor - 1);
  const rows = await db
    .prepare(
      `SELECT p.seq, p.kind, p.id AS post_id, p.author_id, pe.email AS author_email, pe.name AS author_name,
              p.connection_label, p.body, p.reply_to, p.published_at
         FROM posts p LEFT JOIN people pe ON pe.id = p.author_id
        WHERE p.room_id = ? AND p.status = 'published' AND p.seq > ? AND p.seq >= ?
        ORDER BY p.seq ASC LIMIT ?`,
    )
    .bind(roomId, from, floor, limit + 1)
    .all<VisibleMessage>();
  const hasMore = rows.results.length > limit;
  return { messages: rows.results.slice(0, limit), hasMore };
}

export async function readRoom(
  env: Env,
  actor: ToolActor,
  input: { room_id: string; after_seq?: number; limit?: number; wait_seconds?: number },
): Promise<ReadResult> {
  const db = env.DB;
  const afterSeq = Math.max(0, Math.floor(input.after_seq ?? 0));
  const limit = Math.min(LIMITS.readLimitMax, Math.max(1, Math.floor(input.limit ?? 50)));
  const waitSeconds = Math.min(LIMITS.waitSecondsMax, Math.max(0, Math.floor(input.wait_seconds ?? 0)));
  const deadline = Date.now() + waitSeconds * 1000;

  let access = await roomForMember(db, actor.person.id, input.room_id);
  let page = await visibleMessages(db, access.room.id, access.floor, afterSeq, limit);
  while (page.messages.length === 0 && Date.now() < deadline) {
    await sleep(Math.min(1500, Math.max(0, deadline - Date.now())));
    // Re-check access on every poll: revocation and removal end reads already in progress.
    await loadToolActor(env, { personId: actor.person.id, connectionId: actor.connection.id });
    access = await roomForMember(db, actor.person.id, input.room_id);
    page = await visibleMessages(db, access.room.id, access.floor, afterSeq, limit);
  }

  const { room, floor } = access;
  const [held, members] = await Promise.all([
    db
      .prepare("SELECT id, body, created_at FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held' AND created_at > ?")
      .bind(room.id, actor.person.id, now() - LIMITS.heldPostTtl)
      .all<{ id: string; body: string; created_at: number }>(),
    membersOf(db, room.id),
  ]);
  const last = page.messages.at(-1);
  const nextAfterSeq = last ? last.seq : Math.max(afterSeq, floor - 1);

  let waitingOn: string | null = null;
  if (page.messages.length === 0) {
    const others = members.filter((m) => m.person_id !== actor.person.id);
    if (held.results.length > 0) waitingOn = "your held post: your human has to release it on the web page";
    else if (others.length === 0) waitingOn = "someone to accept the invite to this room";
    else {
      const lastVisible = await db
        .prepare("SELECT author_id FROM posts WHERE room_id = ? AND status = 'published' AND kind = 'message' AND seq >= ? ORDER BY seq DESC LIMIT 1")
        .bind(room.id, floor)
        .first<{ author_id: string }>();
      waitingOn =
        lastVisible?.author_id === actor.person.id
          ? `a reply from ${others.map((o) => o.email).join(", ")}`
          : "a new message";
    }
  }

  return {
    room_id: room.id,
    room_title: room.title,
    messages: page.messages,
    next_after_seq: nextAfterSeq,
    has_more: page.hasMore,
    your_held_posts: held.results.map((h) => ({ post_id: h.id, body: h.body, created_at: h.created_at, review_url: reviewUrl(env, h.id) })),
    waiting_on: waitingOn,
    members,
  };
}

// ---------- one post ----------

export interface PostInfo {
  post_id: string;
  room_id: string;
  status: PostStatus;
  seq: number | null;
  note: string | null;
  created_at: number;
  decided_at: number | null;
  review_url: string | null;
}

/** Only the author (any of their connections) can see a post's status. */
export async function getPost(env: Env, actor: ToolActor, postId: string): Promise<PostInfo> {
  const db = env.DB;
  const t = now();
  await db
    .prepare(`UPDATE posts SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'held' AND created_at <= ?`)
    .bind(t, postId, t - LIMITS.heldPostTtl)
    .run();
  const p = await db
    .prepare("SELECT * FROM posts WHERE id = ? AND author_id = ? AND kind = 'message'")
    .bind(postId, actor.person.id)
    .first<PostRow>();
  if (!p) fail("not_found");
  // A post in a room the person has left is still theirs, but only report it while they are a member.
  const member = await db
    .prepare("SELECT 1 FROM memberships WHERE room_id = ? AND person_id = ? AND left_at IS NULL")
    .bind(p.room_id, actor.person.id)
    .first();
  if (!member) fail("not_found");
  return {
    post_id: p.id,
    room_id: p.room_id,
    status: p.status,
    seq: p.seq,
    note: p.status === "rejected" ? p.decision_note : null,
    created_at: p.created_at,
    decided_at: p.decided_at,
    review_url: p.status === "held" ? reviewUrl(env, p.id) : null,
  };
}

export async function cancelHeldPost(env: Env, actor: ToolActor, postId: string): Promise<PostInfo> {
  const db = env.DB;
  const t = now();
  const res = await db
    .prepare(
      `UPDATE posts SET status = 'cancelled', decided_at = ?
        WHERE id = ? AND author_id = ? AND status = 'held' AND created_at > ?
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = posts.room_id AND m.person_id = posts.author_id AND m.left_at IS NULL)`,
    )
    .bind(t, postId, actor.person.id, t - LIMITS.heldPostTtl)
    .run();
  if (res.meta.changes === 0) {
    const info = await getPost(env, actor, postId); // not_found if it is not theirs
    if (info.status !== "held") fail("not_held", `That post is ${info.status}, not waiting.`);
    fail("conflict");
  }
  await auditStmt(db, { person: actor.person.id, connection: actor.connection.id, action: "post.cancel", target: postId }).run();
  return getPost(env, actor, postId);
}

// ---------- held posts on the web ----------

export interface HeldDetail {
  post: PostRow;
  room: { id: string; title: string; purpose: string; history_mode: string; membership_version: number };
  recipients: { person_id: string; email: string; name: string; needs_approval: boolean }[];
  prospective: { email: string; needs_approval: boolean }[];
  context: VisibleMessage[];
  connection_label: string;
  waited_seconds: number;
  expired: boolean;
}

export async function listHeldFor(db: D1Database, personId: string): Promise<(PostRow & { room_title: string })[]> {
  const rows = await db
    .prepare(
      `SELECT p.*, r.title AS room_title FROM posts p JOIN rooms r ON r.id = p.room_id
        WHERE p.author_id = ? AND p.status = 'held' AND p.created_at > ?
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = p.room_id AND m.person_id = p.author_id AND m.left_at IS NULL)
        ORDER BY p.created_at ASC LIMIT 100`,
    )
    .bind(personId, now() - LIMITS.heldPostTtl)
    .all<PostRow & { room_title: string }>();
  return rows.results;
}

export async function heldDetail(db: D1Database, personId: string, postId: string): Promise<HeldDetail> {
  const post = await db
    .prepare("SELECT * FROM posts WHERE id = ? AND author_id = ? AND kind = 'message'")
    .bind(postId, personId)
    .first<PostRow>();
  if (!post) fail("not_found");
  const { room, floor } = await roomForMember(db, personId, post.room_id);
  const members = await membersOf(db, room.id);
  const grants = await db
    .prepare(
      `SELECT person_id FROM room_grants WHERE room_id = ? AND granter_id = ?
       UNION SELECT person_id FROM allowlist WHERE owner_id = ?`,
    )
    .bind(room.id, personId, personId)
    .all<{ person_id: string }>();
  const covered = new Set(grants.results.map((g) => g.person_id));
  const recipients = members
    .filter((m) => m.person_id !== personId)
    .map((m) => ({ person_id: m.person_id, email: m.email, name: m.name, needs_approval: !covered.has(m.person_id) }));
  const prospective: { email: string; needs_approval: boolean }[] = [];
  if (room.history_mode === "full") {
    const inv = await db
      .prepare("SELECT email, inviter_id, inviter_grant FROM invites WHERE room_id = ? AND status = 'confirmed' AND expires_at > ?")
      .bind(room.id, now())
      .all<{ email: string; inviter_id: string; inviter_grant: number }>();
    for (const i of inv.results) prospective.push({ email: i.email, needs_approval: !(i.inviter_id === personId && i.inviter_grant === 1) });
  }
  const ctxRows = await db
    .prepare(
      `SELECT p.seq, p.kind, p.id AS post_id, p.author_id, pe.email AS author_email, pe.name AS author_name,
              p.connection_label, p.body, p.reply_to, p.published_at
         FROM posts p LEFT JOIN people pe ON pe.id = p.author_id
        WHERE p.room_id = ? AND p.status = 'published' AND p.seq >= ?
        ORDER BY p.seq DESC LIMIT 3`,
    )
    .bind(room.id, floor)
    .all<VisibleMessage>();
  return {
    post,
    room: { id: room.id, title: room.title, purpose: room.purpose, history_mode: room.history_mode, membership_version: room.membership_version },
    recipients,
    prospective,
    context: ctxRows.results.reverse(),
    connection_label: post.connection_label ?? "",
    waited_seconds: now() - post.created_at,
    expired: post.status === "held" && now() - post.created_at >= LIMITS.heldPostTtl,
  };
}

/**
 * Release (optionally with "trust in this room") or reject a held post. The approval record binds
 * the post id, the body hash and the room's membership version the human saw; all of it is
 * re-checked in the same batch that publishes.
 */
export async function decideHeld(
  env: Env,
  personId: string,
  sessionHash: string,
  approvalId: string,
  decision: "release" | "release_trust" | "reject",
  note?: string,
): Promise<{ post_id: string; status: PostStatus; seq: number | null }> {
  const db = env.DB;
  const approval = await db
    .prepare("SELECT * FROM approvals WHERE id = ? AND person_id = ? AND session_hash = ? AND action = ?")
    .bind(approvalId, personId, sessionHash, `held.${decision}`)
    .first<{ params: string }>();
  if (!approval) fail("approval_invalid");
  const params = JSON.parse(approval.params) as { post_id: string; body_hash: string; membership_version: number };
  const post = await db.prepare("SELECT room_id FROM posts WHERE id = ? AND author_id = ?").bind(params.post_id, personId).first<{ room_id: string }>();
  if (!post) fail("not_found");
  const t = now();
  // ?1 person, ?2 post, ?3 now, ?4 room, ?5 approval id, ?6 body hash, ?7 membership version, ?8 action, ?9 session
  const b = [personId, params.post_id, t, post.room_id, approvalId, params.body_hash, params.membership_version, `held.${decision}`, sessionHash] as const;
  const stmts: D1PreparedStatement[] = [
    assertStmt(
      db,
      `EXISTS (SELECT 1 FROM approvals WHERE id = ?5 AND person_id = ?1 AND session_hash = ?9 AND action = ?8
                 AND used_at IS NULL AND expires_at > ?3)`,
      "approval_invalid",
      ...b,
    ),
    assertStmt(
      db,
      `EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND author_id = ?1 AND room_id = ?4 AND status = 'held'
                 AND created_at > ?3 - ${LIMITS.heldPostTtl})`,
      "not_held",
      ...b,
    ),
    assertStmt(db, "EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND body_hash = ?6)", "body_changed", ...b),
    assertStmt(db, "EXISTS (SELECT 1 FROM rooms WHERE id = ?4 AND membership_version = ?7)", "membership_changed", ...b),
    assertStmt(
      db,
      "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)",
      "not_member",
      ...b,
    ),
    stmt(
          db,
          "UPDATE approvals SET used_at = ?3 WHERE id = ?5",
          b,
        ),
  ];
  if (decision === "reject") {
    stmts.push(
      stmt(
          db,
          "UPDATE posts SET status = 'rejected', decided_at = ?3, decision_note = ?10 WHERE id = ?2",
          [...b, stripInvisible(note ?? "").trim().slice(0, LIMITS.noteChars) || null],
        ),
    );
  } else {
    stmts.push(
      stmt(
          db,
          `UPDATE posts SET status = 'published', seq = (SELECT next_seq FROM rooms WHERE id = ?4),
                  published_at = ?3, decided_at = ?3 WHERE id = ?2`,
          b,
        ),
      stmt(
          db,
          "UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?4",
          b,
        ),
    );
    if (decision === "release_trust") {
      // Trust covers exactly the people in the room now (the membership version was just checked).
      stmts.push(
        stmt(
          db,
          `INSERT OR IGNORE INTO room_grants (room_id, granter_id, person_id, source, created_at)
             SELECT ?4, ?1, m.person_id, 'release_and_trust', ?3 FROM memberships m
              WHERE m.room_id = ?4 AND m.left_at IS NULL AND m.person_id != ?1`,
          b,
        ),
      );
    }
  }
  stmts.push(auditStmt(db, { person: personId, action: `held.${decision}`, room: post.room_id, target: params.post_id }));
  await runBatch(db, stmts);
  const after = await db.prepare("SELECT status, seq FROM posts WHERE id = ?").bind(params.post_id).first<{ status: PostStatus; seq: number | null }>();
  return { post_id: params.post_id, status: after!.status, seq: after!.seq };
}
