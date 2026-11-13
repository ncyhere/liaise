import type { Env } from "../env";
import { fail, runBatch } from "./errors";
import { auditStmt } from "./infra";
import { LIMITS, type Connection, type Person } from "./model";
import { checkPost } from "./secrets/check";
import { newId, normalizeEmail, now, oneLine, safeLabel } from "./util";

/** Finds or creates the person for a provider subject. Email and name are refreshed on each sign-in. */
export async function upsertPerson(
  db: D1Database,
  provider: "google" | "dev",
  subject: string,
  rawEmail: string,
  rawName: string,
): Promise<Person> {
  const email = normalizeEmail(rawEmail);
  if (!email) fail("invalid_input", "The sign-in did not return a usable email address.");
  const name = oneLine(rawName, 80);
  const t = now();
  await db
    .prepare(
      `INSERT INTO people (id, provider, subject, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, name = excluded.name`,
    )
    .bind(newId("p"), provider, subject, email, name, t)
    .run();
  const person = await db.prepare("SELECT * FROM people WHERE provider = ? AND subject = ?").bind(provider, subject).first<Person>();
  if (!person) fail("internal");
  return person;
}

export async function setPersonPaused(env: Env, personId: string, paused: boolean): Promise<void> {
  const db = env.DB;
  await runBatch(db, [
    db.prepare("UPDATE people SET paused = ? WHERE id = ?").bind(paused ? 1 : 0, personId),
    auditStmt(db, { person: personId, action: paused ? "person.pause" : "person.resume" }),
  ]);
}

// ---------- connections ----------

export async function createConnection(
  db: D1Database,
  personId: string,
  c: { clientId: string; clientName: string; clientDomain?: string | null; redirectUri: string; label: string; trust: "read_only" | "gated" },
): Promise<Connection> {
  const id = newId("conn");
  const t = now();
  // The client chooses its own name; one that looks like a secret is not stored or audited.
  const clientName = checkPost(c.clientName, []).hold ? "(name withheld: it looked like a secret)" : oneLine(c.clientName, 100);
  const label = safeLabel(c.label) || "Agent";
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO connections (id, person_id, client_id, client_name, client_domain, redirect_uri, label, trust, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, personId, c.clientId, clientName, c.clientDomain ?? null, c.redirectUri, label, c.trust, t, t + LIMITS.connectionMaxAge),
    auditStmt(db, { person: personId, connection: id, action: "connection.create", detail: clientName }),
  ]);
  const row = await db.prepare("SELECT * FROM connections WHERE id = ?").bind(id).first<Connection>();
  return row!;
}

export async function listConnections(db: D1Database, personId: string): Promise<Connection[]> {
  const rows = await db
    .prepare("SELECT * FROM connections WHERE person_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100")
    .bind(personId, now())
    .all<Connection>();
  return rows.results;
}

/** Revokes in D1 (effective on the next request) and deletes the matching OAuth grant. */
export async function revokeConnection(env: Env, personId: string, connectionId: string, reason = "revoked by owner"): Promise<void> {
  const db = env.DB;
  const res = await db
    .prepare("UPDATE connections SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND person_id = ? AND revoked_at IS NULL")
    .bind(now(), reason, connectionId, personId)
    .run();
  if (res.meta.changes === 0) fail("not_found");
  await auditStmt(db, { person: personId, connection: connectionId, action: "connection.revoke" }).run();
  await revokeGrantsFor(env, personId, (meta) => meta?.connectionId === connectionId);
}

export async function revokeGrantsFor(env: Env, personId: string, match: (metadata: { connectionId?: string } | undefined) => boolean): Promise<void> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) return; // D1 revocation alone already blocks every request.
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(personId, { cursor });
    for (const g of page.items) if (match(g.metadata)) await helpers.revokeGrant(g.id, personId);
    cursor = page.cursor;
  } while (cursor);
}

export async function setConnectionPaused(env: Env, personId: string, connectionId: string, paused: boolean): Promise<void> {
  const db = env.DB;
  const res = await db
    .prepare("UPDATE connections SET paused = ? WHERE id = ? AND person_id = ? AND revoked_at IS NULL")
    .bind(paused ? 1 : 0, connectionId, personId)
    .run();
  if (res.meta.changes === 0) fail("not_found");
  await auditStmt(db, { person: personId, connection: connectionId, action: paused ? "connection.pause" : "connection.resume" }).run();
}

/** Lowering to read_only is always allowed; raising to gated needs a fresh sign-in (checked by the caller). */
export async function setConnectionTrust(env: Env, personId: string, connectionId: string, trust: "read_only" | "gated"): Promise<void> {
  const db = env.DB;
  const res = await db
    .prepare("UPDATE connections SET trust = ? WHERE id = ? AND person_id = ? AND revoked_at IS NULL")
    .bind(trust, connectionId, personId)
    .run();
  if (res.meta.changes === 0) fail("not_found");
  await auditStmt(db, { person: personId, connection: connectionId, action: `connection.trust.${trust}` }).run();
}
