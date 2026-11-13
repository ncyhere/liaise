import type { Env } from "../env";
import { assertStmt, fail, runBatch } from "./errors";
import { auditStmt, hitWriteRates } from "./infra";
import { CONNECTION_ACTIVE_SQL, LIMITS, type Room, type ToolActor } from "./model";
import { checkPost } from "./secrets/check";
import { newId, now, oneLine, stripInvisible } from "./util";

/**
 * Room titles, purposes and connection labels are shown to other people: one that looks like it
 * holds a secret is refused before it is stored, and the error never repeats the value.
 */
export function refuseSecretMetadata(field: string, value: string): void {
  if (!value) return;
  const check = checkPost(value, []);
  if (check.hold) fail("possible_secret", `The ${field} looks like it contains a secret (rule: ${check.rules.join(", ")}). Nothing was stored.`);
}

export interface Member {
  person_id: string;
  email: string;
  name: string;
  visibility_floor: number;
  joined_at: number;
}

export interface RoomAccess {
  room: Room;
  floor: number;
}

/**
 * The only way to reach a room: the person must be a current member. A room that does not exist
 * and a room you are not in look the same (not_found).
 */
export async function roomForMember(db: D1Database, personId: string, roomId: string): Promise<RoomAccess> {
  const row = await db
    .prepare(
      `SELECT r.*, m.visibility_floor AS floor FROM rooms r
         JOIN memberships m ON m.room_id = r.id
        WHERE r.id = ? AND m.person_id = ? AND m.left_at IS NULL`,
    )
    .bind(roomId, personId)
    .first<Room & { floor: number }>();
  if (!row) fail("not_found");
  const { floor, ...room } = row;
  return { room, floor };
}

export async function membersOf(db: D1Database, roomId: string): Promise<Member[]> {
  const rows = await db
    .prepare(
      `SELECT m.person_id, p.email, p.name, m.visibility_floor, m.joined_at
         FROM memberships m JOIN people p ON p.id = m.person_id
        WHERE m.room_id = ? AND m.left_at IS NULL ORDER BY m.joined_at, p.email`,
    )
    .bind(roomId)
    .all<Member>();
  return rows.results;
}

/**
 * SQL that is true when posts by `author` in `room` need no approval: every other current member
 * is covered by the author's room grant or allowlist, and (in a full-history room) nobody holds a
 * confirmed invite the author has not opted in to, since they would read the post on joining.
 * Parameters: ?1 author person id, ?3 now, ?4 room id.
 */
export const COVERED_SQL = `(
  NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.room_id = ?4 AND m.left_at IS NULL AND m.person_id != ?1
       AND NOT EXISTS (SELECT 1 FROM room_grants g
                        WHERE g.room_id = ?4 AND g.granter_id = ?1 AND g.person_id = m.person_id)
       AND NOT EXISTS (SELECT 1 FROM allowlist a WHERE a.owner_id = ?1 AND a.person_id = m.person_id))
  AND NOT EXISTS (
    SELECT 1 FROM invites i JOIN rooms r ON r.id = i.room_id
     WHERE i.room_id = ?4 AND r.history_mode = 'full' AND i.status = 'confirmed' AND i.expires_at > ?3
       AND NOT (i.inviter_id = ?1 AND i.inviter_grant = 1))
)`;

export type Coverage = "you" | "no_approval_needed" | "approval_needed";

/** Why each other member is covered for `viewerId` in a room: a room grant, the allowlist, or both. */
export async function coverageSources(db: D1Database, roomId: string, viewerId: string): Promise<Map<string, { grant: boolean; allowlist: boolean }>> {
  const rows = await db
    .prepare(
      `SELECT m.person_id,
              EXISTS (SELECT 1 FROM room_grants g WHERE g.room_id = m.room_id AND g.granter_id = ?2 AND g.person_id = m.person_id) AS grant_,
              EXISTS (SELECT 1 FROM allowlist a WHERE a.owner_id = ?2 AND a.person_id = m.person_id) AS allow_
         FROM memberships m WHERE m.room_id = ?1 AND m.left_at IS NULL AND m.person_id != ?2`,
    )
    .bind(roomId, viewerId)
    .all<{ person_id: string; grant_: number; allow_: number }>();
  return new Map(rows.results.map((r) => [r.person_id, { grant: r.grant_ === 1, allowlist: r.allow_ === 1 }]));
}

/** Per-member marks for `viewerId`'s outbound gate in a room. */
export async function coverageFor(db: D1Database, roomId: string, viewerId: string): Promise<Map<string, Coverage>> {
  const rows = await db
    .prepare(
      `SELECT m.person_id,
              (EXISTS (SELECT 1 FROM room_grants g WHERE g.room_id = m.room_id AND g.granter_id = ?2 AND g.person_id = m.person_id)
               OR EXISTS (SELECT 1 FROM allowlist a WHERE a.owner_id = ?2 AND a.person_id = m.person_id)) AS covered
         FROM memberships m WHERE m.room_id = ?1 AND m.left_at IS NULL`,
    )
    .bind(roomId, viewerId)
    .all<{ person_id: string; covered: number }>();
  const out = new Map<string, Coverage>();
  for (const r of rows.results) {
    out.set(r.person_id, r.person_id === viewerId ? "you" : r.covered ? "no_approval_needed" : "approval_needed");
  }
  return out;
}

export async function createRoom(
  env: Env,
  actor: ToolActor,
  input: { title: string; purpose: string; history_mode?: "from_join" | "full" },
): Promise<Room> {
  const title = oneLine(input.title, LIMITS.titleChars);
  const purpose = stripInvisible(input.purpose).trim().slice(0, LIMITS.purposeChars);
  if (!title) fail("invalid_input", "A room needs a title.");
  refuseSecretMetadata("title", title);
  refuseSecretMetadata("purpose", purpose);
  const historyMode = input.history_mode ?? "from_join";
  if (historyMode !== "from_join" && historyMode !== "full") fail("invalid_input", "history_mode must be from_join or full.");
  await hitWriteRates(env.DB, actor.person.id, actor.connection.id);

  const id = newId("room");
  const t = now();
  const db = env.DB;
  await runBatch(db, [
    assertStmt(db, CONNECTION_ACTIVE_SQL, "connection_inactive", actor.person.id, actor.connection.id, t),
    assertStmt(
      db,
      `(SELECT count(*) FROM memberships WHERE person_id = ? AND left_at IS NULL) < ${LIMITS.roomsPerPerson}`,
      "limit_reached",
      actor.person.id,
    ),
    db
      .prepare(
        `INSERT INTO rooms (id, title, purpose, history_mode, max_members, creator_id, membership_version, next_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      )
      .bind(id, title, purpose, historyMode, LIMITS.maxMembersV01, actor.person.id, t),
    db
      .prepare("INSERT INTO memberships (room_id, person_id, visibility_floor, joined_at) VALUES (?, ?, 1, ?)")
      .bind(id, actor.person.id, t),
    auditStmt(db, { person: actor.person.id, connection: actor.connection.id, action: "room.create", room: id }),
  ]);
  return {
    id,
    title,
    purpose,
    history_mode: historyMode,
    max_members: LIMITS.maxMembersV01,
    creator_id: actor.person.id,
    membership_version: 1,
    next_seq: 1,
    created_at: t,
  };
}

export interface RoomSummary {
  hold_every_post: boolean;
  room: Room;
  floor: number;
  members: (Member & { mark: Coverage })[];
  last_seq: number;
  your_held: number;
  open_invite: { email: string; status: string } | null;
}

export async function listRoomsFor(db: D1Database, personId: string): Promise<RoomSummary[]> {
  const rooms = await db
    .prepare(
      `SELECT r.*, m.visibility_floor AS floor, m.hold_every_post AS hep FROM rooms r JOIN memberships m ON m.room_id = r.id
        WHERE m.person_id = ? AND m.left_at IS NULL ORDER BY r.created_at DESC LIMIT ?`,
    )
    .bind(personId, LIMITS.roomsPerPerson)
    .all<Room & { floor: number; hep: number }>();
  const out: RoomSummary[] = [];
  for (const { floor, hep, ...room } of rooms.results) {
    const [members, marks, held, invite] = await Promise.all([
      membersOf(db, room.id),
      coverageFor(db, room.id, personId),
      db
        .prepare("SELECT count(*) AS n FROM posts WHERE room_id = ? AND author_id = ? AND status = 'held' AND created_at > ?")
        .bind(room.id, personId, now() - LIMITS.heldPostTtl)
        .first<{ n: number }>(),
      db
        .prepare("SELECT email, status FROM invites WHERE room_id = ? AND status IN ('proposed','confirmed') AND expires_at > ?")
        .bind(room.id, now())
        .first<{ email: string; status: string }>(),
    ]);
    out.push({
      hold_every_post: hep === 1,
      room,
      floor,
      members: members.map((m) => ({ ...m, mark: marks.get(m.person_id) ?? "approval_needed" })),
      last_seq: room.next_seq - 1,
      your_held: held?.n ?? 0,
      open_invite: invite ?? null,
    });
  }
  return out;
}
