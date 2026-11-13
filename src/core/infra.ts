import type { Env } from "../env";
import { fail } from "./errors";
import { newId, now } from "./util";

// ---------- rate limits ----------

/** Fixed-window counter in D1. Throws rate_limited when the window's count passes `limit`. */
export async function hitRate(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowStart = Math.floor(now() / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (row && row.count > limit) fail("rate_limited");
}

export const RATES = {
  toolCallsPerConnectionPerMinute: 120,
  writesPerConnectionPerMinute: 20,
  writesPerPersonPerMinute: 30,
  writesGlobalPerMinute: 1000,
  registrationsPerIpPerHour: 20,
  registrationsGlobalPerHour: 300,
  signInsPerIpPerHour: 60,
};

export async function hitWriteRates(db: D1Database, personId: string, connectionId: string): Promise<void> {
  await hitRate(db, `w:c:${connectionId}`, RATES.writesPerConnectionPerMinute, 60);
  await hitRate(db, `w:p:${personId}`, RATES.writesPerPersonPerMinute, 60);
  await hitRate(db, "w:global", RATES.writesGlobalPerMinute, 60);
}

// ---------- audit ----------

export function auditStmt(
  db: D1Database,
  a: { person?: string | null; connection?: string | null; action: string; room?: string | null; target?: string | null; detail?: string | null },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit (at, person_id, connection_id, action, room_id, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(now(), a.person ?? null, a.connection ?? null, a.action, a.room ?? null, a.target ?? null, a.detail ?? null);
}

// ---------- notices ----------

/**
 * Email notices name the room and a count, never message content. Without a configured
 * provider they are only recorded in the `notices` table and logged.
 */
export interface Notifier {
  send(to: string, subject: string, text: string): Promise<void>;
}

class LogNotifier implements Notifier {
  async send(to: string, subject: string): Promise<void> {
    console.log(`notice (no email provider configured) to=${to.replace(/^(.).*@/, "$1…@")} subject=${JSON.stringify(subject)}`);
  }
}

/** Resend-compatible HTTP API. Untested against the live service in v0.1. */
class ResendNotifier implements Notifier {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}
  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`email provider returned ${res.status}`);
  }
}

export function notifierFor(env: Env): Notifier {
  if (env.RESEND_API_KEY && env.NOTIFY_FROM) return new ResendNotifier(env.RESEND_API_KEY, env.NOTIFY_FROM);
  return new LogNotifier();
}

export async function sendNotice(
  env: Env,
  n: { personId: string; email: string; kind: "held" | "room_changed"; roomId: string; count: number; subject: string; text: string },
): Promise<void> {
  const id = newId("ntc");
  await env.DB.prepare(
    "INSERT INTO notices (id, person_id, kind, room_id, count, subject, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, n.personId, n.kind, n.roomId, n.count, n.subject, n.text, now())
    .run();
  try {
    await notifierFor(env).send(n.email, n.subject, n.text);
    await env.DB.prepare("UPDATE notices SET sent_at = ? WHERE id = ?").bind(now(), id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE notices SET error = ? WHERE id = ?").bind(String(e).slice(0, 300), id).run();
  }
}
