import { fail } from "./errors";
import { LIMITS } from "./model";
import { canonicalJson, newId, now } from "./util";

/**
 * A server-stored approval: created when a page with a sensitive action is shown, bound to the
 * person, their browser session, the action and its exact parameters. The form carries only its
 * id; the parameters are read back from here, never from the form.
 */
export async function createApproval(
  db: D1Database,
  personId: string,
  sessionHash: string,
  action: string,
  params: Record<string, unknown>,
): Promise<string> {
  const id = newId("apv");
  const t = now();
  await db
    .prepare("INSERT INTO approvals (id, person_id, session_hash, action, params, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, personId, sessionHash, action, canonicalJson(params), t, t + LIMITS.approvalTtl)
    .run();
  return id;
}

export async function loadApproval<T>(
  db: D1Database,
  approvalId: string,
  personId: string,
  sessionHash: string,
  action: string,
): Promise<T> {
  const row = await db
    .prepare(
      "SELECT params FROM approvals WHERE id = ? AND person_id = ? AND session_hash = ? AND action = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(approvalId, personId, sessionHash, action, now())
    .first<{ params: string }>();
  if (!row) fail("approval_invalid");
  return JSON.parse(row.params) as T;
}

/**
 * SQL for an `_assert` that the approval is still valid, and the statement that consumes it.
 * Parameters: ?1 person, ?3 now, then the approval id, session hash and action at the given indexes.
 */
export function approvalValidSql(idIdx: number, sessionIdx: number, actionIdx: number): string {
  return `EXISTS (SELECT 1 FROM approvals WHERE id = ?${idIdx} AND person_id = ?1 AND session_hash = ?${sessionIdx}
            AND action = ?${actionIdx} AND used_at IS NULL AND expires_at > ?3)`;
}
