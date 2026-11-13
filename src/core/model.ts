import type { Env } from "../env";
import { fail } from "./errors";
import { DAY, now } from "./util";

export const LIMITS = {
  messageBytes: 16 * 1024,
  titleChars: 120,
  purposeChars: 1000,
  noteChars: 1000,
  reasonChars: 500,
  roomsPerPerson: 50,
  openInvitesPerPerson: 10,
  pendingRequestsPerPerson: 20,
  readLimitMax: 100,
  waitSecondsMax: 25,
  maxMembersV01: 2,
  heldPostTtl: 1 * DAY,
  proposedInviteTtl: 1 * DAY,
  confirmedInviteTtl: 7 * DAY,
  connectionMaxAge: 90 * DAY,
  approvalTtl: 10 * 60,
  freshSignIn: 10 * 60,
  webSessionTtl: 7 * DAY,
} as const;

export interface Person {
  id: string;
  provider: string;
  subject: string;
  email: string;
  name: string;
  paused: number;
  created_at: number;
}

export interface Connection {
  id: string;
  person_id: string;
  client_id: string;
  client_name: string;
  client_domain: string | null;
  redirect_uri: string;
  label: string;
  trust: "read_only" | "gated";
  paused: number;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface Room {
  id: string;
  title: string;
  purpose: string;
  history_mode: "from_join" | "full";
  max_members: number;
  creator_id: string;
  membership_version: number;
  next_seq: number;
  created_at: number;
}

export interface PostRow {
  id: string;
  room_id: string;
  kind: "message" | "system";
  author_id: string | null;
  connection_id: string | null;
  connection_label: string | null;
  body: string;
  body_hash: string;
  reply_to: number | null;
  status: "held" | "published" | "rejected" | "cancelled" | "expired";
  hold_reason: "needs_approval" | "possible_secret" | "hold_every_post" | null;
  secret_rules: string | null;
  scan_context: string;
  scan_rule_version: string | null;
  seq: number | null;
  membership_version: number;
  created_at: number;
  published_at: number | null;
  decided_at: number | null;
  decision_note: string | null;
}

/** The caller of an MCP tool: always a person and the connection they approved. */
export interface ToolActor {
  person: Person;
  connection: Connection;
}

export async function getPerson(db: D1Database, id: string): Promise<Person | null> {
  return db.prepare("SELECT * FROM people WHERE id = ?").bind(id).first<Person>();
}

export function globallyPaused(env: Env): boolean {
  return env.GLOBAL_PAUSE === "1";
}

/**
 * Loads the actor for an MCP request from the OAuth props, re-checking the connection in D1 on
 * every call so revocation, pause and the 90-day cap take effect at once.
 */
export async function loadToolActor(
  env: Env,
  props: { personId?: unknown; connectionId?: unknown } | undefined,
): Promise<ToolActor> {
  const personId = typeof props?.personId === "string" ? props.personId : null;
  const connectionId = typeof props?.connectionId === "string" ? props.connectionId : null;
  if (!personId || !connectionId) fail("connection_inactive");
  const row = await env.DB.prepare(
    `SELECT c.*, p.provider AS p_provider, p.subject AS p_subject, p.email AS p_email, p.name AS p_name,
            p.paused AS p_paused, p.created_at AS p_created_at
       FROM connections c JOIN people p ON p.id = c.person_id
      WHERE c.id = ? AND c.person_id = ?`,
  )
    .bind(connectionId, personId)
    .first<Connection & { p_provider: string; p_subject: string; p_email: string; p_name: string; p_paused: number; p_created_at: number }>();
  const t = now();
  if (!row || row.revoked_at !== null || row.expires_at <= t) fail("connection_inactive");
  if (row.last_used_at === null || t - row.last_used_at > 60) {
    await env.DB.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").bind(t, row.id).run();
  }
  const { p_provider, p_subject, p_email, p_name, p_paused, p_created_at, ...connection } = row;
  return {
    person: { id: personId, provider: p_provider, subject: p_subject, email: p_email, name: p_name, paused: p_paused, created_at: p_created_at },
    connection,
  };
}

/** Pause applies to every tool except whoami. */
export function requireNotPaused(env: Env, actor: ToolActor): void {
  if (globallyPaused(env) || actor.person.paused || actor.connection.paused) fail("paused");
}

/** SQL that is true when the connection may write right now (checked inside batches). */
export const CONNECTION_ACTIVE_SQL = `EXISTS (
  SELECT 1 FROM connections c JOIN people p ON p.id = c.person_id
   WHERE c.id = ?2 AND c.person_id = ?1 AND c.revoked_at IS NULL AND c.paused = 0
     AND c.expires_at > ?3 AND p.paused = 0)`;
