import type { Env } from "../env";
import { approvalValidSql, loadApproval } from "./approvals";
import { assertStmt, fail, runBatch, stmt } from "./errors";
import { auditStmt, hitWriteRates, sendNotice } from "./infra";
import { CONNECTION_ACTIVE_SQL, LIMITS, type Person, type Room } from "./model";
import { membersOf, roomForMember, type Member } from "./rooms";
import { newId, normalizeEmail, now, oneLine, randomToken, sha256 } from "./util";

export interface InviteRow {
  id: string;
  room_id: string;
  inviter_id: string;
  email: string;
  status: "proposed" | "confirmed" | "accepted" | "revoked" | "expired" | "declined";
  token_hash: string | null;
  inviter_grant: number;
  proposed_by_connection: string | null;
  created_at: number;
  confirmed_at: number | null;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
}

export function confirmUrl(env: Env, inviteId: string): string {
  return `${env.PUBLIC_ORIGIN}/app/invites/${inviteId}`;
}

export function joinUrl(env: Env, token: string): string {
  return `${env.PUBLIC_ORIGIN}/join/${token}`;
}

/** ?1 room, ?2 now: marks the room's open invites that have run out as expired. */
const EXPIRE_ROOM_INVITES_SQL = `UPDATE invites SET status = 'expired'
  WHERE room_id = ?1 AND status IN ('proposed', 'confirmed') AND expires_at <= ?2`;

/**
 * Proposes adding an email address to a room. Nothing happens until the inviter's human confirms
 * it on the web; `connectionId` is null when the human starts it there.
 */
export async function proposeInvite(
  env: Env,
  inviter: Person,
  connectionId: string | null,
  input: { room_id: string; email: string },
): Promise<{ invite_id: string; confirm_url: string; email: string }> {
  const email = normalizeEmail(input.email);
  if (!email) fail("invalid_input", "That is not a valid email address.");
  const db = env.DB;
  const { room } = await roomForMember(db, inviter.id, input.room_id);
  if (email === inviter.email) fail("invalid_input", "You cannot invite yourself.");
  const members = await membersOf(db, room.id);
  if (members.some((m) => m.email === email)) fail("already_member", "That person is already in this room.");
  if (members.length >= room.max_members) fail("room_full");
  if (connectionId) await hitWriteRates(db, inviter.id, connectionId);

  const t = now();
  await stmt(db, EXPIRE_ROOM_INVITES_SQL, [room.id, t]).run();
  const open = await db
    .prepare("SELECT id FROM invites WHERE room_id = ? AND status IN ('proposed', 'confirmed')")
    .bind(room.id)
    .first();
  if (open) fail("invite_open");

  const id = newId("inv");
  // ?1 inviter, ?2 connection, ?3 now, ?4 room, ?5 invite id, ?6 email
  const b = [inviter.id, connectionId ?? "", t, room.id, id, email] as const;
  const stmts: D1PreparedStatement[] = [];
  if (connectionId) stmts.push(assertStmt(db, CONNECTION_ACTIVE_SQL, "connection_inactive", ...b));
  stmts.push(
    assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)", "not_found", ...b),
    assertStmt(
      db,
      `(SELECT count(*) FROM invites WHERE inviter_id = ?1 AND status IN ('proposed','confirmed') AND expires_at > ?3) < ${LIMITS.openInvitesPerPerson}`,
      "limit_reached",
      ...b,
    ),
    stmt(
      db,
      `INSERT INTO invites (id, room_id, inviter_id, email, status, proposed_by_connection, created_at, expires_at)
       VALUES (?5, ?4, ?1, ?6, 'proposed', NULLIF(?2, ''), ?3, ?3 + ${LIMITS.proposedInviteTtl})`,
      b,
    ),
    auditStmt(db, { person: inviter.id, connection: connectionId, action: "invite.propose", room: room.id, target: id }),
  );
  await runBatch(db, stmts, "invite_open");
  return { invite_id: id, confirm_url: confirmUrl(env, id), email };
}

export interface InviteForInviter {
  invite: InviteRow;
  room: Room;
  members: Member[];
  earlier_messages: number;
}

export async function inviteForInviter(db: D1Database, personId: string, inviteId: string): Promise<InviteForInviter> {
  const invite = await db.prepare("SELECT * FROM invites WHERE id = ? AND inviter_id = ?").bind(inviteId, personId).first<InviteRow>();
  if (!invite) fail("not_found");
  const { room } = await roomForMember(db, personId, invite.room_id);
  const members = await membersOf(db, room.id);
  return { invite, room, members, earlier_messages: room.next_seq - 1 };
}

/**
 * The inviter's human confirms an invite. Returns the raw token for the link, shown once.
 * `inviterGrant` is "my agents may post to this person in this room without asking".
 */
export async function confirmInvite(
  env: Env,
  personId: string,
  sessionHash: string,
  approvalId: string,
  inviterGrant: boolean,
): Promise<{ invite_id: string; link: string }> {
  const db = env.DB;
  const params = await loadApproval<{ invite_id: string; room_id: string }>(db, approvalId, personId, sessionHash, "invite.confirm");
  const token = randomToken();
  const tokenHash = await sha256(token);
  const t = now();
  // ?1 person, ?2 invite, ?3 now, ?4 room, ?5 approval, ?6 session, ?7 action, ?8 token hash, ?9 grant
  const b = [personId, params.invite_id, t, params.room_id, approvalId, sessionHash, "invite.confirm", tokenHash, inviterGrant ? 1 : 0] as const;
  await runBatch(db, [
    assertStmt(db, approvalValidSql(5, 6, 7), "approval_invalid", ...b),
    assertStmt(
      db,
      "EXISTS (SELECT 1 FROM invites WHERE id = ?2 AND inviter_id = ?1 AND room_id = ?4 AND status = 'proposed' AND expires_at > ?3)",
      "invite_invalid",
      ...b,
    ),
    assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)", "not_member", ...b),
    assertStmt(
      db,
      "(SELECT count(*) FROM memberships WHERE room_id = ?4 AND left_at IS NULL) < (SELECT max_members FROM rooms WHERE id = ?4)",
      "room_full",
      ...b,
    ),
    stmt(db, "UPDATE approvals SET used_at = ?3 WHERE id = ?5", b),
    stmt(
      db,
      `UPDATE invites SET status = 'confirmed', token_hash = ?8, inviter_grant = ?9, confirmed_at = ?3,
              expires_at = ?3 + ${LIMITS.confirmedInviteTtl} WHERE id = ?2`,
      b,
    ),
    // Who may read the room is about to change: held posts shown before this must be re-reviewed.
    stmt(db, "UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?4", b),
    auditStmt(db, { person: personId, action: "invite.confirm", room: params.room_id, target: params.invite_id, detail: `grant=${inviterGrant ? 1 : 0}` }),
  ]);
  return { invite_id: params.invite_id, link: joinUrl(env, token) };
}

/** Issues a fresh link for a confirmed invite (the old one stops working). */
export async function relinkInvite(env: Env, personId: string, inviteId: string): Promise<{ link: string }> {
  const token = randomToken();
  const res = await env.DB.prepare(
    "UPDATE invites SET token_hash = ? WHERE id = ? AND inviter_id = ? AND status = 'confirmed' AND expires_at > ?",
  )
    .bind(await sha256(token), inviteId, personId, now())
    .run();
  if (res.meta.changes === 0) fail("invite_invalid");
  return { link: joinUrl(env, token) };
}

export async function revokeInvite(env: Env, personId: string, inviteId: string): Promise<void> {
  const db = env.DB;
  const inv = await db
    .prepare("SELECT room_id, status FROM invites WHERE id = ? AND inviter_id = ?")
    .bind(inviteId, personId)
    .first<{ room_id: string; status: string }>();
  if (!inv) fail("not_found");
  await runBatch(db, [
    db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? AND status IN ('proposed', 'confirmed')").bind(inviteId),
    db.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ? AND ? = 'confirmed'").bind(inv.room_id, inv.status),
    auditStmt(db, { person: personId, action: "invite.revoke", room: inv.room_id, target: inviteId }),
  ]);
}

export interface InviteForInvitee {
  invite: InviteRow;
  room: Room;
  members: Member[];
  inviter: { id: string; email: string; name: string };
  email_matches: boolean;
}

/** What an invitee sees before accepting. Any signed-in person holding the link can see it. */
export async function inviteByToken(db: D1Database, viewer: Person, token: string): Promise<InviteForInvitee> {
  return inviteByTokenHash(db, viewer, await sha256(token));
}

export async function inviteByTokenHash(db: D1Database, viewer: Person, tokenHash: string): Promise<InviteForInvitee> {
  const invite = await db
    .prepare("SELECT * FROM invites WHERE token_hash = ? AND status = 'confirmed' AND expires_at > ?")
    .bind(tokenHash, now())
    .first<InviteRow>();
  if (!invite) fail("invite_invalid");
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(invite.room_id).first<Room>();
  const inviter = await db.prepare("SELECT id, email, name FROM people WHERE id = ?").bind(invite.inviter_id).first<{ id: string; email: string; name: string }>();
  if (!room || !inviter) fail("invite_invalid");
  return { invite, room, members: await membersOf(db, room.id), inviter, email_matches: viewer.email === invite.email };
}

/**
 * Accepting consumes the invite and creates the membership in one transaction, after checking the
 * invite, the invitee's verified email, that the inviter is still a member and the room has space.
 */
export async function acceptInvite(
  env: Env,
  invitee: Person,
  sessionHash: string,
  approvalId: string,
  inviteeGrant: boolean,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<{ room_id: string; seq: number }> {
  const db = env.DB;
  const params = await loadApproval<{ invite_id: string; room_id: string; token_hash: string }>(
    db,
    approvalId,
    invitee.id,
    sessionHash,
    "invite.accept",
  );
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(params.room_id).first<Room>();
  if (!room) fail("invite_invalid");
  const t = now();
  const sysId = newId("post");
  // Only the verified email appears in the system line: display names are free text.
  const line =
    room.history_mode === "full"
      ? `${invitee.email} joined and can read the whole history of this room.`
      : `${invitee.email} joined and cannot see earlier messages. Don't restate them without your human's say-so.`;
  // ?1 invitee, ?2 invite, ?3 now, ?4 room, ?5 approval, ?6 session, ?7 action, ?8 email,
  // ?9 token hash, ?10 system post id, ?11 system line, ?12 invitee grant
  const b = [invitee.id, params.invite_id, t, room.id, approvalId, sessionHash, "invite.accept", invitee.email, params.token_hash, sysId, line, inviteeGrant ? 1 : 0] as const;
  await runBatch(db, [
    assertStmt(db, approvalValidSql(5, 6, 7), "approval_invalid", ...b),
    assertStmt(
      db,
      "EXISTS (SELECT 1 FROM invites WHERE id = ?2 AND room_id = ?4 AND status = 'confirmed' AND expires_at > ?3 AND token_hash = ?9 AND email = ?8)",
      "invite_invalid",
      ...b,
    ),
    assertStmt(
      db,
      "EXISTS (SELECT 1 FROM memberships m JOIN invites i ON i.inviter_id = m.person_id WHERE i.id = ?2 AND m.room_id = ?4 AND m.left_at IS NULL)",
      "inviter_left",
      ...b,
    ),
    assertStmt(db, "NOT EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1)", "already_member", ...b),
    assertStmt(
      db,
      "(SELECT count(*) FROM memberships WHERE room_id = ?4 AND left_at IS NULL) < (SELECT max_members FROM rooms WHERE id = ?4)",
      "room_full",
      ...b,
    ),
    stmt(db, "UPDATE approvals SET used_at = ?3 WHERE id = ?5", b),
    stmt(db, "UPDATE invites SET status = 'accepted', accepted_at = ?3, accepted_by = ?1 WHERE id = ?2", b),
    stmt(
      db,
      `INSERT INTO posts (id, room_id, kind, author_id, connection_id, connection_label, body, body_hash, status, seq, membership_version, created_at, published_at)
       SELECT ?10, ?4, 'system', NULL, NULL, NULL, ?11, '', 'published', r.next_seq, r.membership_version + 1, ?3, ?3 FROM rooms r WHERE r.id = ?4`,
      b,
    ),
    stmt(
      db,
      `INSERT INTO memberships (room_id, person_id, visibility_floor, joined_at)
       SELECT ?4, ?1, CASE r.history_mode WHEN 'full' THEN 1 ELSE r.next_seq END, ?3 FROM rooms r WHERE r.id = ?4`,
      b,
    ),
    stmt(db, "UPDATE rooms SET next_seq = next_seq + 1, membership_version = membership_version + 1 WHERE id = ?4", b),
    // The inviter's opt-in, made when they confirmed, now covers this person.
    stmt(
      db,
      `INSERT OR IGNORE INTO room_grants (room_id, granter_id, person_id, source, created_at)
       SELECT ?4, i.inviter_id, ?1, 'invite', ?3 FROM invites i WHERE i.id = ?2 AND i.inviter_grant = 1`,
      b,
    ),
    // The invitee's own opt-in (off by default).
    stmt(
      db,
      `INSERT OR IGNORE INTO room_grants (room_id, granter_id, person_id, source, created_at)
       SELECT ?4, ?1, i.inviter_id, 'accept', ?3 FROM invites i WHERE i.id = ?2 AND ?12 = 1`,
      b,
    ),
    auditStmt(db, { person: invitee.id, action: "invite.accept", room: room.id, target: params.invite_id }),
  ]);
  const seqRow = await db.prepare("SELECT seq FROM posts WHERE id = ?").bind(sysId).first<{ seq: number }>();

  const inviter = await db
    .prepare("SELECT p.id, p.email FROM invites i JOIN people p ON p.id = i.inviter_id WHERE i.id = ?")
    .bind(params.invite_id)
    .first<{ id: string; email: string }>();
  if (inviter) {
    const notice = sendNotice(env, {
      personId: inviter.id,
      email: inviter.email,
      kind: "room_changed",
      roomId: room.id,
      count: 1,
      subject: `Liaise: someone joined "${oneLine(room.title, 60)}"`,
      text: `${invitee.email} accepted your invite and joined the room "${oneLine(room.title, 80)}".\n\n${env.PUBLIC_ORIGIN}/app/rooms/${room.id}\n`,
    });
    if (ctx) ctx.waitUntil(notice);
    else await notice;
  }
  return { room_id: room.id, seq: seqRow?.seq ?? 0 };
}

export async function declineInvite(env: Env, invitee: Person, token: string): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE invites SET status = 'declined' WHERE token_hash = ? AND status = 'confirmed' AND email = ? AND expires_at > ?",
  )
    .bind(await sha256(token), invitee.email, now())
    .run();
  if (res.meta.changes === 0) fail("invite_invalid");
}

/** Invites a person should act on: ones their agents proposed, and ones sent to their email. */
export async function invitesFor(
  db: D1Database,
  person: Person,
): Promise<{ to_confirm: (InviteRow & { room_title: string })[]; to_accept: (InviteRow & { room_title: string; inviter_email: string })[] }> {
  const t = now();
  const [mine, forMe] = await Promise.all([
    db
      .prepare(
        `SELECT i.*, r.title AS room_title FROM invites i JOIN rooms r ON r.id = i.room_id
          WHERE i.inviter_id = ? AND i.status IN ('proposed', 'confirmed') AND i.expires_at > ? ORDER BY i.created_at DESC LIMIT 50`,
      )
      .bind(person.id, t)
      .all<InviteRow & { room_title: string }>(),
    db
      .prepare(
        `SELECT i.*, r.title AS room_title, p.email AS inviter_email FROM invites i
           JOIN rooms r ON r.id = i.room_id JOIN people p ON p.id = i.inviter_id
          WHERE i.email = ? AND i.status = 'confirmed' AND i.expires_at > ? ORDER BY i.created_at DESC LIMIT 50`,
      )
      .bind(person.email, t)
      .all<InviteRow & { room_title: string; inviter_email: string }>(),
  ]);
  return { to_confirm: mine.results, to_accept: forMe.results };
}
