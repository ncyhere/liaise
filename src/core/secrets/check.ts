import { keyedHash } from "../util";
import { maskValue, scanText, type Finding } from "./scan";

export { RULES_VERSION } from "./scan";

/** One piece of text in a scan: an earlier post (with its id) or the new post (id null). */
export interface Segment {
  id: string | null;
  text: string;
  /** Keyed hash of the stored body, for binding a release to what was scanned. */
  h?: string;
}

export interface Range {
  segment: number;
  start: number;
  end: number;
}

export interface SecretMatch {
  rule: string;
  value: string;
  ranges: Range[];
}

export interface CheckResult {
  /** True when the post must be held: a match, or the scanner failed (fail closed). */
  hold: boolean;
  matches: SecretMatch[];
  /** Rule ids for the agent and the audit record: never the values. */
  rules: string[];
  /** Earlier posts that took part in a match. */
  contributing: { id: string; h: string }[];
}

/** The rule name used when the scanner could not finish: the post is held anyway. */
export const SCAN_FAILED_RULE = "scanner-limit";

/**
 * Checks a new post on its own, and joined to the same person's recent posts in the room. A match
 * in the joined text counts only if it overlaps the new post, so a secret split across posts is
 * caught without re-holding something already in an earlier post. Never throws: any scanner
 * error holds the post.
 */
export function checkPost(body: string, context: Segment[]): CheckResult {
  const segments: Segment[] = [...context, { id: null, text: body }];
  const newIndex = segments.length - 1;
  const matches: SecretMatch[] = [];
  try {
    for (const f of scanText(body)) matches.push({ rule: f.rule, value: f.value, ranges: [{ segment: newIndex, start: f.start, end: f.end }] });
    if (context.length > 0) {
      const offsets: number[] = [];
      let joined = "";
      for (const s of segments) {
        offsets.push(joined.length);
        joined += s.text;
      }
      const newStart = offsets[newIndex]!;
      for (const f of scanText(joined)) {
        if (f.end <= newStart) continue; // entirely in earlier posts
        if (f.start >= newStart && matches.some((m) => m.rule === f.rule && m.value === f.value)) continue;
        matches.push({ rule: f.rule, value: f.value, ranges: splitRange(f, segments, offsets) });
      }
    }
  } catch {
    return { hold: true, matches: [], rules: [SCAN_FAILED_RULE], contributing: [] };
  }
  const rules = [...new Set(matches.map((m) => m.rule))];
  const used = new Set(matches.flatMap((m) => m.ranges.map((r) => r.segment)).filter((i) => i !== newIndex));
  const contributing = [...used].sort((a, b) => a - b).map((i) => ({ id: segments[i]!.id!, h: segments[i]!.h ?? "" }));
  return { hold: matches.length > 0, matches, rules, contributing };
}

function splitRange(f: Finding, segments: Segment[], offsets: number[]): Range[] {
  const out: Range[] = [];
  segments.forEach((s, i) => {
    const a = offsets[i]!;
    const b = a + s.text.length;
    const start = Math.max(f.start, a);
    const end = Math.min(f.end, b);
    if (end > start) out.push({ segment: i, start: start - a, end: end - a });
  });
  return out;
}

/** For the audit record: rule names with a keyed hash of each value. */
export async function auditSummary(hashKey: string, result: CheckResult): Promise<string> {
  const parts: string[] = [];
  for (const m of result.matches) parts.push(`${m.rule}:${(await keyedHash(hashKey, m.value)).slice(0, 16)}`);
  return parts.length ? parts.join(" ") : result.rules.join(" ");
}

export interface MaskedPart {
  text: string;
  masked: boolean;
}

/** Splits one segment's text into plain parts and masked parts (first 6 and last 4 shown). */
export function maskSegment(text: string, segment: number, matches: SecretMatch[]): MaskedPart[] {
  const ranges = matches
    .flatMap((m) => m.ranges.filter((r) => r.segment === segment))
    .sort((a, b) => a.start - b.start);
  const parts: MaskedPart[] = [];
  let at = 0;
  for (const r of ranges) {
    const start = Math.max(r.start, at);
    if (start >= r.end) continue;
    if (start > at) parts.push({ text: text.slice(at, start), masked: false });
    parts.push({ text: maskValue(text.slice(start, r.end)), masked: true });
    at = r.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), masked: false });
  return parts;
}
