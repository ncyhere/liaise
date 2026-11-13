import type { Env } from "../env";
import { assertStmt, fail, LiaiseError, runBatch, stmt } from "./errors";
import { auditStmt, hitRate, hitWriteRates, RATES, sendNotice } from "./infra";
import { CONNECTION_ACTIVE_SQL, globallyPaused, LIMITS, loadToolActor, requireNotPaused, type PostRow, type ToolActor } from "./model";
import { COVERED_SQL, membersOf, roomForMember, type Member } from "./rooms";
import { auditSummary, checkPost, maskSegment, RULES_VERSION, type MaskedPart, type Segment } from "./secrets/check";
import { byteLength, keyedHash, newId, now, oneLine, stripInvisible } from "./util";

export type PostStatus = "held" | "published" | "rejected" | "cancelled" | "expired";
export type HoldReason = "needs_approval" | "possible_secret" | "hold_every_post";
/** What send_message reports. A retry reports the existing post's current status. */
export type SendStatus = "published" | "pending_approval" | "blocked_by_held" | "rejected" | "cancelled" | "expired";

export interface SendResult {
  status: SendStatus;
  post_id: string | null;
  room_id: string;
  seq: number | null;
  reason: HoldReason | null;
  /** Secret rules that matched (names only, never the matched text). */
  rules: string[];
  review_url: string | null;
  held_post_id: string | null;
  replayed: boolean;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{1,128}$/;
/** The same person's recent posts in a room that a new post is scanned together with. */
const CONTEXT_POSTS = 3;
const CONTEXT_SECONDS = 10 * 60;

export function reviewUrl(env: Env, postId: string): string {
  return `${env.PUBLIC_ORIGIN}/app/held/${postId}`;
}

/** Expiring a held post also deletes its body. ?1 author, ?3 now, ?4 room. */
const EXPIRE_STALE_HELD_SQL = `UPDATE posts SET status = 'expired', body = '', decided_at = ?3
  WHERE room_id = ?4 AND author_id = ?1 AND status = 'held' AND created_at <= ?3 - ${LIMITS.heldPostTtl}`;

/** Expires one post if its time is up. */
async function expireIfStale(db: D1Database, postId: string): Promise<void> {
  const t = now();
  await db
    .prepare("UPDATE posts SET status = 'expired', body = '', decided_at = ? WHERE id = ? AND status = 'held' AND created_at <= ?")
    .bind(t, postId, t - LIMITS.heldPostTtl)
    .run();
}

function parseRules(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type OutcomeRow = { id: string; status: PostStatus; seq: number | null; hold_reason: HoldReason | null; secret_rules: string | null };

function resultFor(env: Env, p: OutcomeRow, roomId: string, replayed: boolean): SendResult {
  const held = p.status === "held";
  return {
    status: (held ? "pending_approval" : p.status) as SendStatus,
    post_id: p.id,
    room_id: roomId,
    seq: p.seq,
    reason: held ? p.hold_reason : null,
    rules: held ? parseRules(p.secret_rules) : [],
    review_url: held ? reviewUrl(env, p.id) : null,
    held_post_id: held ? p.id : null,
    replayed,
  };
}

async function replay(env: Env, existing: { body_hash: string; post_id: string }, bodyHash: string, roomId: string): Promise<SendResult> {
  if (existing.body_hash !== bodyHash) fail("idempotency_conflict");
  await expireIfStale(env.DB, existing.post_id);
  const p = await env.DB.prepare("SELECT id, status, seq, hold_reason, secret_rules FROM posts WHERE id = ?").bind(existing.post_id).first<OutcomeRow>();
  if (!p) fail("internal");
  return resultFor(env, p, roomId, true);
}

function blocked(env: Env, roomId: string, heldId: string): SendResult {
  return { status: "blocked_by_held", post_id: null, room_id: roomId, seq: null, reason: null, rules: [], review_url: reviewUrl(env, heldId), held_post_id: heldId, replayed: false };
}

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
    const target =
      Number.isInteger(input.reply_to) && input.reply_to >= floor
        ? await db.prepare("SELECT 1 FROM posts WHERE room_id = ? AND seq = ? AND status = 'published'").bind(room.id, input.reply_to).first()
        : null;
    if (!target) fail("invalid_input", "reply_to must be the number of a message you can see in this room.");
  }
  const bodyHash = await keyedHash(env.HASH_KEY, body);

  // A retry with the same key reports the existing post's current status, before anything else.
  const existing = await db
    .prepare("SELECT body_hash, post_id FROM idempotency WHERE connection_id = ? AND room_id = ? AND key = ?")
    .bind(actor.connection.id, room.id, input.idempotency_key)
    .first<{ body_hash: string; post_id: string }>();
  if (existing) return replay(env, existing, bodyHash, room.id);

  await hitWriteRates(db, actor.person.id, actor.connection.id);
  await hitRate(db, `posts:day:${actor.person.id}`, RATES.postsPerPersonPerDay, 86400);

  for (let attempt = 0; attempt < 3; attempt++) {
    const t = now();
    const held = await db
      .prepare("SELECT id FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held' AND created_at > ?")
      .bind(room.id, actor.person.id, t - LIMITS.heldPostTtl)
      .first<{ id: string }>();
    if (held) return blocked(env, room.id, held.id);

    // The secret check: this post alone, and joined to this person's last posts in the room.
    const recent = await db
      .prepare(
        `SELECT id, body, body_hash FROM posts
          WHERE room_id = ? AND author_id = ? AND kind = 'message' AND status IN ('published', 'held') AND body != '' AND created_at > ?
          ORDER BY rowid DESC LIMIT ${CONTEXT_POSTS}`,
      )
      .bind(room.id, actor.person.id, t - CONTEXT_SECONDS)
      .all<{ id: string; body: string; body_hash: string }>();
    const latest = await db
      .prepare("SELECT id FROM posts WHERE room_id = ? AND author_id = ? AND kind = 'message' ORDER BY rowid DESC LIMIT 1")
      .bind(room.id, actor.person.id)
      .first<{ id: string }>();
    const context: Segment[] = recent.results.reverse().map((r) => ({ id: r.id, text: r.body, h: r.body_hash }));
    const check = checkPost(body, context);
    const auditDetail = check.hold ? await auditSummary(env.HASH_KEY, check) : null;

    const postId = newId("post");
    // ?1 author, ?2 connection, ?3 now, ?4 room, ?5 post, ?6 label, ?7 body, ?8 hash, ?9 reply_to,
    // ?10 secret flag, ?11 rules json, ?12 scan context json, ?13 rule version, ?14 latest post id
    const b = [
      actor.person.id,
      actor.connection.id,
      t,
      room.id,
      postId,
      actor.connection.label,
      body,
      bodyHash,
      input.reply_to ?? null,
      check.hold ? 1 : 0,
      check.hold ? JSON.stringify(check.rules) : null,
      JSON.stringify(check.contributing),
      RULES_VERSION,
      latest?.id ?? null,
    ] as const;
    let results: D1Result[];
    try {
      results = await runBatch(db, [
        stmt(db, EXPIRE_STALE_HELD_SQL, b),
        assertStmt(db, CONNECTION_ACTIVE_SQL, "connection_inactive", ...b),
        assertStmt(db, "EXISTS (SELECT 1 FROM connections WHERE id = ?2 AND trust = 'gated')", "read_only", ...b),
        assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)", "not_found", ...b),
        // One held post per person per room, whatever this post's fate.
        assertStmt(db, "NOT EXISTS (SELECT 1 FROM posts WHERE room_id = ?4 AND author_id = ?1 AND status = 'held')", "blocked_by_held", ...b),
        // Publish only against the context that was scanned; otherwise scan again.
        assertStmt(
          db,
          "(SELECT id FROM posts WHERE room_id = ?4 AND author_id = ?1 AND kind = 'message' ORDER BY rowid DESC LIMIT 1) IS ?14",
          "context_changed",
          ...b,
        ),
        // The decision is made here, inside the transaction that writes the post.
        stmt(
          db,
          `INSERT INTO posts (id, room_id, kind, author_id, connection_id, connection_label, body, body_hash, reply_to,
                              status, seq, membership_version, created_at, published_at,
                              hold_reason, secret_rules, scan_context, scan_rule_version)
           SELECT ?5, r.id, 'message', ?1, ?2, ?6, ?7, ?8, ?9,
                  CASE WHEN f.reason IS NULL THEN 'published' ELSE 'held' END,
                  CASE WHEN f.reason IS NULL THEN r.next_seq ELSE NULL END,
                  r.membership_version, ?3,
                  CASE WHEN f.reason IS NULL THEN ?3 ELSE NULL END,
                  f.reason, ?11, ?12, ?13
             FROM rooms r,
                  (SELECT CASE WHEN ?10 = 1 THEN 'possible_secret'
                               WHEN EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND hold_every_post = 1)
                                 THEN 'hold_every_post'
                               WHEN ${COVERED_SQL} THEN NULL
                               ELSE 'needs_approval' END AS reason) f
            WHERE r.id = ?4`,
          b,
        ),
        stmt(db, "UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?4 AND EXISTS (SELECT 1 FROM posts WHERE id = ?5 AND status = 'published')", b),
        stmt(db, "INSERT INTO idempotency (connection_id, room_id, key, body_hash, post_id, created_at) VALUES (?2, ?4, ?6, ?7, ?5, ?3)", [
          actor.person.id,
          actor.connection.id,
          t,
          room.id,
          postId,
          input.idempotency_key,
          bodyHash,
        ]),
        auditStmt(db, {
          person: actor.person.id,
          connection: actor.connection.id,
          action: "post.send",
          room: room.id,
          target: postId,
          detail: auditDetail ? `possible_secret ${auditDetail}` : null,
        }),
        // Read the outcome inside the same transaction.
        stmt(db, "SELECT id, status, seq, hold_reason, secret_rules FROM posts WHERE id = ?5", b),
      ]);
    } catch (e) {
      if (e instanceof LiaiseError && e.code === "context_changed") continue;
      if (e instanceof LiaiseError && (e.code === "blocked_by_held" || e.code === "conflict")) {
        // Lost a race: the same idempotency key, or another post just became held.
        const again = await db
          .prepare("SELECT body_hash, post_id FROM idempotency WHERE connection_id = ? AND room_id = ? AND key = ?")
          .bind(actor.connection.id, room.id, input.idempotency_key)
          .first<{ body_hash: string; post_id: string }>();
        if (again) return replay(env, again, bodyHash, room.id);
        const nowHeld = await db
          .prepare("SELECT id FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held'")
          .bind(room.id, actor.person.id)
          .first<{ id: string }>();
        if (nowHeld) return blocked(env, room.id, nowHeld.id);
      }
      throw e;
    }
    const outcome = results.at(-1)?.results?.[0] as OutcomeRow | undefined;
    if (!outcome) fail("internal");
    const result = resultFor(env, outcome, room.id, false);
    if (outcome.status === "held") {
      // Notices go only to the author's own person, and never carry content or matched values.
      const why =
        outcome.hold_reason === "possible_secret"
          ? ` It looks like it contains a secret (${result.rules.join(", ")}).`
          : outcome.hold_reason === "hold_every_post"
            ? " You asked for every post in this room to wait for you."
            : "";
      const notice = sendNotice(env, {
        personId: actor.person.id,
        email: actor.person.email,
        kind: "held",
        roomId: room.id,
        count: 1,
        subject: `Liaise: a post is waiting for you in "${oneLine(room.title, 60)}"`,
        text:
          `One post from your agent (${actor.connection.label}) is waiting for your review in the room ` +
          `"${oneLine(room.title, 80)}".${why} Nobody else can see it until you release it.\n\n` +
          `Review it: ${reviewUrl(env, outcome.id)}\n`,
      });
      if (ctx) ctx.waitUntil(notice);
      else await notice;
    }
    return result;
  }
  fail("conflict", "The room kept changing while your post was checked. Try again.");
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
  your_held_posts: { post_id: string; body: string; created_at: number; review_url: string; reason: HoldReason | null }[];
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

/** Re-checks everything that grants access to a room right now: connection, pause, membership. */
async function recheck(env: Env, actor: ToolActor, roomId: string) {
  const fresh = await loadToolActor(env, { personId: actor.person.id, connectionId: actor.connection.id });
  requireNotPaused(env, fresh);
  return roomForMember(env.DB, actor.person.id, roomId);
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
  if (waitSeconds > 0) {
    await hitRate(db, `wait:c:${actor.connection.id}`, RATES.waitsPerConnectionPerMinute, 60);
    // One cheap query per poll: is there anything new, and may this connection still read?
    while (Date.now() < deadline) {
      const s = await db
        .prepare(
          `SELECT r.next_seq AS next_seq,
                  EXISTS (SELECT 1 FROM memberships WHERE room_id = ?1 AND person_id = ?2 AND left_at IS NULL) AS member,
                  EXISTS (SELECT 1 FROM connections c JOIN people p ON p.id = c.person_id
                           WHERE c.id = ?3 AND c.person_id = ?2 AND c.revoked_at IS NULL AND c.paused = 0
                             AND c.expires_at > ?4 AND p.paused = 0) AS active
             FROM rooms r WHERE r.id = ?1`,
        )
        .bind(access.room.id, actor.person.id, actor.connection.id, now())
        .first<{ next_seq: number; member: number; active: number }>();
      if (!s?.member || !s.active || globallyPaused(env)) access = await recheck(env, actor, input.room_id); // throws the right error
      if (s && s.next_seq - 1 > Math.max(afterSeq, access.floor - 1)) break;
      await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
  }
  const page = await visibleMessages(db, access.room.id, access.floor, afterSeq, limit);
  const [held, members] = await Promise.all([
    db
      .prepare("SELECT id, body, created_at, hold_reason FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held' AND created_at > ?")
      .bind(access.room.id, actor.person.id, now() - LIMITS.heldPostTtl)
      .all<{ id: string; body: string; created_at: number; hold_reason: HoldReason | null }>(),
    membersOf(db, access.room.id),
  ]);
  // Access is checked again after the data is read: a revocation or pause that landed meanwhile wins.
  const { room, floor } = await recheck(env, actor, input.room_id);

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
      waitingOn = lastVisible?.author_id === actor.person.id ? `a reply from ${others.map((o) => o.email).join(", ")}` : "a new message";
    }
  }
  return {
    room_id: room.id,
    room_title: room.title,
    messages: page.messages,
    next_after_seq: nextAfterSeq,
    has_more: page.hasMore,
    your_held_posts: held.results.map((h) => ({ post_id: h.id, body: h.body, created_at: h.created_at, review_url: reviewUrl(env, h.id), reason: h.hold_reason })),
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
  reason: HoldReason | null;
  rules: string[];
  note: string | null;
  created_at: number;
  decided_at: number | null;
  review_url: string | null;
}

/** Only the author (any of their connections) can see a post's status. */
export async function getPost(env: Env, actor: ToolActor, postId: string): Promise<PostInfo> {
  const db = env.DB;
  await expireIfStale(db, postId);
  const p = await db
    .prepare(
      `SELECT p.* FROM posts p
        WHERE p.id = ? AND p.author_id = ? AND p.kind = 'message'
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = p.room_id AND m.person_id = p.author_id AND m.left_at IS NULL)`,
    )
    .bind(postId, actor.person.id)
    .first<PostRow>();
  if (!p) fail("not_found");
  const held = p.status === "held";
  return {
    post_id: p.id,
    room_id: p.room_id,
    status: p.status,
    seq: p.seq,
    reason: held ? p.hold_reason : null,
    rules: held ? parseRules(p.secret_rules) : [],
    note: p.status === "rejected" ? p.decision_note : null,
    created_at: p.created_at,
    decided_at: p.decided_at,
    review_url: held ? reviewUrl(env, p.id) : null,
  };
}

export async function cancelHeldPost(env: Env, actor: ToolActor, postId: string): Promise<PostInfo> {
  const db = env.DB;
  const t = now();
  const res = await db
    .prepare(
      `UPDATE posts SET status = 'cancelled', body = '', decided_at = ?
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

export interface ContributingView {
  id: string;
  seq: number | null;
  status: PostStatus;
  removed: boolean;
  masked: MaskedPart[];
  full: string;
}

export interface HeldDetail {
  post: PostRow;
  room: { id: string; title: string; purpose: string; history_mode: string; membership_version: number };
  recipients: { person_id: string; email: string; name: string; needs_approval: boolean }[];
  prospective: { email: string; needs_approval: boolean }[];
  context: VisibleMessage[];
  connection_label: string;
  waited_seconds: number;
  expired: boolean;
  /** For secret holds: the post masked, and the earlier posts the match used. */
  secret: { rules: string[]; masked: MaskedPart[]; contributing: ContributingView[]; scanStale: boolean } | null;
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

function parseContext(json: string): { id: string; h: string }[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as { id: string; h: string }[]).filter((x) => typeof x?.id === "string") : [];
  } catch {
    return [];
  }
}

export async function heldDetail(db: D1Database, personId: string, postId: string): Promise<HeldDetail> {
  await expireIfStale(db, postId);
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

  let secret: HeldDetail["secret"] = null;
  if (post.status === "held" && post.hold_reason === "possible_secret") {
    // Re-run the deterministic scan over the same posts to know what to mask.
    const ctxRefs = parseContext(post.scan_context);
    const ctxPosts: { id: string; body: string; body_hash: string; seq: number | null; status: PostStatus }[] = [];
    for (const c of ctxRefs) {
      const row = await db
        .prepare("SELECT id, body, body_hash, seq, status FROM posts WHERE id = ? AND author_id = ? AND room_id = ?")
        .bind(c.id, personId, room.id)
        .first<{ id: string; body: string; body_hash: string; seq: number | null; status: PostStatus }>();
      if (row) ctxPosts.push(row);
    }
    const check = checkPost(post.body, ctxPosts.map((c) => ({ id: c.id, text: c.body, h: c.body_hash })));
    const newIndex = ctxPosts.length;
    secret = {
      rules: parseRules(post.secret_rules),
      masked: check.matches.length ? maskSegment(post.body, newIndex, check.matches) : [{ text: post.body, masked: false }],
      contributing: ctxPosts.map((c, i) => ({
        id: c.id,
        seq: c.seq,
        status: c.status,
        removed: c.body === "",
        masked: maskSegment(c.body, i, check.matches),
        full: c.body,
      })),
      scanStale: post.scan_rule_version !== RULES_VERSION,
    };
  }
  return {
    post,
    room: { id: room.id, title: room.title, purpose: room.purpose, history_mode: room.history_mode, membership_version: room.membership_version },
    recipients,
    prospective,
    context: ctxRows.results.reverse(),
    connection_label: post.connection_label ?? "",
    waited_seconds: now() - post.created_at,
    expired: post.status === "held" && now() - post.created_at >= LIMITS.heldPostTtl,
    secret,
  };
}

/** What a release or rejection is bound to: everything the human saw and the scan used. */
export interface HeldBinding {
  post_id: string;
  body_hash: string;
  reply_to: number | null;
  scan_context: string;
  scan_rule_version: string | null;
  hold_reason: HoldReason | null;
  membership_version: number;
}

export function bindingFor(d: HeldDetail): HeldBinding {
  return {
    post_id: d.post.id,
    body_hash: d.post.body_hash,
    reply_to: d.post.reply_to,
    scan_context: d.post.scan_context,
    scan_rule_version: d.post.scan_rule_version,
    hold_reason: d.post.hold_reason,
    membership_version: d.room.membership_version,
  };
}

/**
 * Release once, release and trust (only for posts held because someone needed approval), or
 * reject. The approval record binds the post, its body, reply_to, the earlier posts the secret
 * scan used, the rule version and the room's membership version; all of it is re-checked in the
 * batch that publishes. Rejecting deletes the body.
 */
export async function decideHeld(
  env: Env,
  personId: string,
  sessionHash: string,
  approvalId: string,
  decision: "release" | "release_trust" | "reject",
  expectedPostId: string,
  note?: string,
): Promise<{ post_id: string; status: PostStatus; seq: number | null }> {
  const db = env.DB;
  const approval = await db
    .prepare("SELECT * FROM approvals WHERE id = ? AND person_id = ? AND session_hash = ? AND action = ?")
    .bind(approvalId, personId, sessionHash, `held.${decision}`)
    .first<{ params: string }>();
  if (!approval) fail("approval_invalid");
  const params = JSON.parse(approval.params) as HeldBinding;
  if (params.post_id !== expectedPostId) fail("approval_invalid");
  const post = await db.prepare("SELECT room_id FROM posts WHERE id = ? AND author_id = ?").bind(params.post_id, personId).first<{ room_id: string }>();
  if (!post) fail("not_found");
  const t = now();
  // ?1 person, ?2 post, ?3 now, ?4 room, ?5 approval, ?6 body hash, ?7 membership version, ?8 action,
  // ?9 session, ?10 reply_to, ?11 scan context, ?12 rule version, ?13 note
  const b = [
    personId,
    params.post_id,
    t,
    post.room_id,
    approvalId,
    params.body_hash,
    params.membership_version,
    `held.${decision}`,
    sessionHash,
    params.reply_to,
    params.scan_context,
    params.scan_rule_version,
    stripInvisible(note ?? "").trim().slice(0, LIMITS.noteChars) || null,
  ] as const;
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
    assertStmt(
      db,
      "EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND body_hash = ?6 AND reply_to IS ?10 AND scan_context = ?11 AND scan_rule_version IS ?12)",
      "body_changed",
      ...b,
    ),
    // The earlier posts the secret match used are still the ones the human saw.
    assertStmt(
      db,
      `NOT EXISTS (SELECT 1 FROM json_each(?11) j
                    WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = json_extract(j.value, '$.id')
                                        AND p.author_id = ?1 AND p.body_hash = json_extract(j.value, '$.h')))`,
      "body_changed",
      ...b,
    ),
    assertStmt(db, "EXISTS (SELECT 1 FROM rooms WHERE id = ?4 AND membership_version = ?7)", "membership_changed", ...b),
    assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)", "not_member", ...b),
    stmt(db, "UPDATE approvals SET used_at = ?3 WHERE id = ?5", b),
  ];
  if (decision === "reject") {
    stmts.push(stmt(db, "UPDATE posts SET status = 'rejected', body = '', decided_at = ?3, decision_note = ?13 WHERE id = ?2", b));
  } else {
    if (decision === "release_trust") {
      // A secret or hold-every-post hold never offers trust.
      stmts.push(assertStmt(db, "EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND hold_reason = 'needs_approval')", "forbidden", ...b));
    }
    stmts.push(
      stmt(
        db,
        `UPDATE posts SET status = 'published', seq = (SELECT next_seq FROM rooms WHERE id = ?4),
                published_at = ?3, decided_at = ?3 WHERE id = ?2`,
        b,
      ),
      stmt(db, "UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?4", b),
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

/** Turns "hold every post" on or off for this person in a room. Off needs a fresh sign-in (checked by the caller). */
export async function setHoldEveryPost(env: Env, personId: string, roomId: string, on: boolean): Promise<void> {
  const db = env.DB;
  await roomForMember(db, personId, roomId);
  await runBatch(db, [
    db.prepare("UPDATE memberships SET hold_every_post = ? WHERE room_id = ? AND person_id = ? AND left_at IS NULL").bind(on ? 1 : 0, roomId, personId),
    auditStmt(db, { person: personId, action: on ? "room.hold_every_post.on" : "room.hold_every_post.off", room: roomId }),
  ]);
}
