import type { Env } from "../env";
import { approvalValidSql, loadApproval } from "./approvals";
import { assertStmt, fail, runBatch, stmt } from "./errors";
import { auditStmt, hitWriteRates } from "./infra";
import { CONNECTION_ACTIVE_SQL, LIMITS, type ToolActor } from "./model";
import { membersOf, roomForMember } from "./rooms";
import { newId, normalizeEmail, now, stripInvisible } from "./util";

export interface RequestRow {
  id: string;
  owner_id: string;
  connection_id: string;
  room_id: string;
  target_person_id: string;
  scope: "room" | "everywhere";
  reason: string;
  status: "pending" | "approved" | "declined";
  created_at: number;
  decided_at: number | null;
}

/**
 * An agent asks its human to trust someone in a room, or everywhere. The target must be a current
 * member of a room the agent's person is in. Nothing changes until the human decides on the web.
 */
export async function requestAllowlistEntry(
  env: Env,
  actor: ToolActor,
  input: { room_id: string; person: string; scope: "room" | "everywhere"; reason?: string },
): Promise<{ request_id: string | null; status: "pending" | "already_approved"; review_url: string }> {
  const db = env.DB;
  const { room } = await roomForMember(db, actor.person.id, input.room_id);
  const members = await membersOf(db, room.id);
  const email = normalizeEmail(input.person);
  const target = members.find((m) => m.person_id === input.person || (email !== null && m.email === email));
  if (!target) fail("not_found", "That person is not a member of this room.");
  if (target.person_id === actor.person.id) fail("invalid_input", "You cannot ask to trust yourself.");
  if (input.scope !== "room" && input.scope !== "everywhere") fail("invalid_input", "scope must be room or everywhere.");
  const reviewUrl = `${env.PUBLIC_ORIGIN}/app`;

  const covered = await db
    .prepare(
      input.scope === "room"
        ? `SELECT 1 FROM room_grants WHERE room_id = ?1 AND granter_id = ?2 AND person_id = ?3
           UNION SELECT 1 FROM allowlist WHERE owner_id = ?2 AND person_id = ?3`
        : "SELECT 1 FROM allowlist WHERE ?1 IS NOT NULL AND owner_id = ?2 AND person_id = ?3",
    )
    .bind(room.id, actor.person.id, target.person_id)
    .first();
  if (covered) return { request_id: null, status: "already_approved", review_url: reviewUrl };

  const existing = await db
    .prepare(
      "SELECT id FROM allowlist_requests WHERE owner_id = ? AND room_id = ? AND target_person_id = ? AND scope = ? AND status = 'pending'",
    )
    .bind(actor.person.id, room.id, target.person_id, input.scope)
    .first<{ id: string }>();
  if (existing) return { request_id: existing.id, status: "pending", review_url: reviewUrl };

  await hitWriteRates(db, actor.person.id, actor.connection.id);
  const id = newId("req");
  const t = now();
  const reason = stripInvisible(input.reason ?? "").trim().slice(0, LIMITS.reasonChars);
  // ?1 person, ?2 connection, ?3 now, ?4 room, ?5 id, ?6 target, ?7 scope, ?8 reason
  const b = [actor.person.id, actor.connection.id, t, room.id, id, target.person_id, input.scope, reason] as const;
  await runBatch(
    db,
    [
      assertStmt(db, CONNECTION_ACTIVE_SQL, "connection_inactive", ...b),
      assertStmt(
        db,
        `(SELECT count(*) FROM allowlist_requests WHERE owner_id = ?1 AND status = 'pending') < ${LIMITS.pendingRequestsPerPerson}`,
        "limit_reached",
        ...b,
      ),
      stmt(
        db,
        `INSERT INTO allowlist_requests (id, owner_id, connection_id, room_id, target_person_id, scope, reason, status, created_at)
         VALUES (?5, ?1, ?2, ?4, ?6, ?7, ?8, 'pending', ?3)`,
        b,
      ),
      auditStmt(db, { person: actor.person.id, connection: actor.connection.id, action: "request.create", room: room.id, target: id }),
    ],
    "conflict",
  );
  return { request_id: id, status: "pending", review_url: reviewUrl };
}

export async function pendingRequestsFor(
  db: D1Database,
  personId: string,
): Promise<(RequestRow & { room_title: string; target_email: string; target_name: string; connection_label: string })[]> {
  const rows = await db
    .prepare(
      `SELECT q.*, r.title AS room_title, p.email AS target_email, p.name AS target_name, c.label AS connection_label
         FROM allowlist_requests q JOIN rooms r ON r.id = q.room_id JOIN people p ON p.id = q.target_person_id
         JOIN connections c ON c.id = q.connection_id
        WHERE q.owner_id = ? AND q.status = 'pending'
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = q.room_id AND m.person_id = q.owner_id AND m.left_at IS NULL)
        ORDER BY q.created_at ASC LIMIT 50`,
    )
    .bind(personId)
    .all<RequestRow & { room_title: string; target_email: string; target_name: string; connection_label: string }>();
  return rows.results;
}

/** The human approves (fresh sign-in, checked by the caller) or declines a request. */
export async function decideRequest(
  env: Env,
  personId: string,
  sessionHash: string,
  approvalId: string,
  decision: "approve" | "decline",
  expectedRequestId: string,
): Promise<void> {
  const db = env.DB;
  const action = `request.${decision}`;
  const params = await loadApproval<{ request_id: string }>(db, approvalId, personId, sessionHash, action);
  if (params.request_id !== expectedRequestId) fail("approval_invalid");
  const req = await db
    .prepare("SELECT * FROM allowlist_requests WHERE id = ? AND owner_id = ?")
    .bind(params.request_id, personId)
    .first<RequestRow>();
  if (!req) fail("not_found");
  const t = now();
  // ?1 person, ?2 request, ?3 now, ?4 room, ?5 approval, ?6 session, ?7 action, ?8 target
  const b = [personId, req.id, t, req.room_id, approvalId, sessionHash, action, req.target_person_id] as const;
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, approvalValidSql(5, 6, 7), "approval_invalid", ...b),
    assertStmt(db, "EXISTS (SELECT 1 FROM allowlist_requests WHERE id = ?2 AND owner_id = ?1 AND status = 'pending')", "conflict", ...b),
    stmt(db, "UPDATE approvals SET used_at = ?3 WHERE id = ?5", b),
    stmt(db, `UPDATE allowlist_requests SET status = '${decision === "approve" ? "approved" : "declined"}', decided_at = ?3 WHERE id = ?2`, b),
  ];
  if (decision === "approve") {
    stmts.push(
      assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?1 AND left_at IS NULL)", "not_member", ...b),
      assertStmt(db, "EXISTS (SELECT 1 FROM memberships WHERE room_id = ?4 AND person_id = ?8 AND left_at IS NULL)", "membership_changed", ...b),
      req.scope === "room"
        ? stmt(
            db,
            "INSERT OR IGNORE INTO room_grants (room_id, granter_id, person_id, source, created_at) VALUES (?4, ?1, ?8, 'request', ?3)",
            b,
          )
        : stmt(db, "INSERT OR IGNORE INTO allowlist (owner_id, person_id, created_at) VALUES (?1, ?8, ?3)", b),
    );
  }
  stmts.push(auditStmt(db, { person: personId, action, room: req.room_id, target: req.id }));
  await runBatch(db, stmts);
}

/** Lets the human stop trusting someone in a room (removes their room grant). */
export async function removeRoomGrant(env: Env, personId: string, roomId: string, targetId: string): Promise<void> {
  const db = env.DB;
  await runBatch(db, [
    db.prepare("DELETE FROM room_grants WHERE room_id = ? AND granter_id = ? AND person_id = ?").bind(roomId, personId, targetId),
    auditStmt(db, { person: personId, action: "grant.remove", room: roomId, target: targetId }),
  ]);
}

/** Stops trusting someone in every room (removes their allowlist entry). */
export async function removeAllowlistEntry(env: Env, personId: string, targetId: string): Promise<void> {
  const db = env.DB;
  await runBatch(db, [
    db.prepare("DELETE FROM allowlist WHERE owner_id = ? AND person_id = ?").bind(personId, targetId),
    auditStmt(db, { person: personId, action: "allowlist.remove", target: targetId }),
  ]);
}
