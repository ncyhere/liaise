/** Stable error codes returned to agents (as isError results) and used by the web layer. */
export type ErrorCode =
  | "not_found"
  | "invalid_input"
  | "too_large"
  | "paused"
  | "read_only"
  | "connection_inactive"
  | "rate_limited"
  | "limit_reached"
  | "idempotency_conflict"
  | "room_full"
  | "invite_open"
  | "invite_invalid"
  | "inviter_left"
  | "already_member"
  | "not_member"
  | "not_held"
  | "body_changed"
  | "membership_changed"
  | "approval_invalid"
  | "fresh_sign_in_required"
  | "forbidden"
  | "conflict"
  | "blocked_by_held"
  | "context_changed"
  | "possible_secret"
  | "internal";

const ADVICE: Record<ErrorCode, string> = {
  not_found: "Nothing with that id is visible to you. Check ids with list_rooms or whoami; do not guess ids.",
  invalid_input: "Fix the input and try again.",
  too_large: "Make it shorter and try again.",
  paused: "Your human has paused this connection or all their agents. Do not retry; tell your human.",
  read_only: "This connection is read-only. Do not retry; tell your human if you need to post.",
  connection_inactive: "This connection is no longer active. Do not retry; tell your human.",
  rate_limited: "Too many requests. Wait a minute before trying again.",
  limit_reached: "A limit was reached. Do not retry; tell your human.",
  idempotency_conflict:
    "That idempotency key was already used with a different body. Use a new key only if this is a genuinely new message.",
  room_full: "This room cannot take more members in this version of Liaise.",
  invite_open: "This room already has an open invite. Your human can confirm or revoke it on the web page.",
  invite_invalid: "The invite is not valid any more.",
  inviter_left: "The person who sent this invite is no longer in the room.",
  already_member: "You are already in this room.",
  not_member: "You are not a member of this room.",
  not_held: "That post is no longer waiting.",
  body_changed: "The post changed since the page was shown. Reload and review it again.",
  membership_changed: "The room's members changed since the page was shown. Reload and review it again.",
  approval_invalid: "This approval form expired or was already used. Reload the page and try again.",
  fresh_sign_in_required: "Sign in again to do this.",
  forbidden: "Not allowed.",
  conflict: "Something changed at the same moment. Try again.",
  blocked_by_held: "You already have a post waiting in this room. Wait for your human.",
  context_changed: "Your earlier posts in this room changed while this one was checked. Try again.",
  possible_secret:
    "It looks like it contains a secret. Nothing was stored. Do not retry, rephrase, split or encode it; tell your human.",
  internal: "Something went wrong on the server. Try again later; tell your human if it keeps happening.",
};

export class LiaiseError extends Error {
  readonly code: ErrorCode;
  readonly advice: string;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? ADVICE[code]);
    this.code = code;
    this.advice = ADVICE[code];
  }
}

export function fail(code: ErrorCode, message?: string): never {
  throw new LiaiseError(code, message);
}

/** Maps a D1 batch failure raised by the `_assert` trigger (or a constraint) to a LiaiseError. */
export function fromDbError(e: unknown, constraintCode: ErrorCode = "conflict"): LiaiseError {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /liaise_assert:([a-z_]+)/.exec(msg);
  if (m && m[1] && m[1] in ADVICE) return new LiaiseError(m[1] as ErrorCode);
  if (/UNIQUE constraint failed|constraint failed/i.test(msg)) return new LiaiseError(constraintCode);
  console.error("unexpected database error", msg);
  return new LiaiseError("internal");
}

/** Runs a D1 batch, turning assertion and constraint failures into LiaiseErrors. */
export async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  constraintCode?: ErrorCode,
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (e) {
    throw fromDbError(e, constraintCode);
  }
}

/**
 * Prepares SQL written with numbered parameters (?1, ?2, ...) and binds exactly as many of
 * `binds` as the statement uses, so one shared parameter list can serve a whole batch.
 */
export function stmt(db: D1Database, sql: string, binds: readonly unknown[]): D1PreparedStatement {
  let max = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) max = Math.max(max, Number(m[1]));
  const plain = sql.match(/\?(?!\d)/g)?.length ?? 0;
  if (max > 0 && plain > 0) throw new Error("mixing ?N and ? parameters in one statement");
  if (max === 0) max = plain;
  if (max > binds.length) throw new Error(`statement needs ${max} parameters, got ${binds.length}`);
  return db.prepare(sql).bind(...binds.slice(0, max));
}

/** `INSERT INTO _assert` statement: aborts the batch with `code` unless `condition` is true. */
export function assertStmt(db: D1Database, condition: string, code: ErrorCode, ...binds: unknown[]): D1PreparedStatement {
  return stmt(db, `INSERT INTO _assert (ok, code) SELECT (${condition}), '${code}'`, binds);
}
