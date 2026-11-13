import { keyedHash } from "../util";
import { maskValue, scanText } from "./scan";

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

/** Each joined window holds at most this much earlier text before the new post. */
const WINDOW_CONTEXT_CHARS = 16 * 1024;

/**
 * Checks a new post on its own, and in windows that start at each of the same person's recent
 * posts in the room and run to the end of the new post. Starting a window at every earlier post
 * means unrelated text before a split secret cannot hide it. A match in a window counts only if
 * it overlaps the new post, so something already in an earlier post is not held again. Never
 * throws: any scanner error holds the post.
 */
export function checkPost(body: string, context: Segment[]): CheckResult {
  const segments: Segment[] = [...context, { id: null, text: body }];
  const newIndex = segments.length - 1;
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();
  const add = (rule: string, value: string, ranges: Range[]) => {
    const k = `${rule}\u0000${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    matches.push({ rule, value, ranges });
  };
  try {
    for (const f of scanText(body)) add(f.rule, f.value, [{ segment: newIndex, start: f.start, end: f.end }]);
    // Offsets of every segment in the full concatenation.
    const offsets: number[] = [];
    let total = 0;
    for (const s of segments) {
      offsets.push(total);
      total += s.text.length;
    }
    const newStart = offsets[newIndex]!;
    let previousStart = -1;
    for (let j = 0; j < context.length; j++) {
      const windowStart = Math.max(offsets[j]!, newStart - WINDOW_CONTEXT_CHARS);
      if (windowStart === previousStart) continue;
      previousStart = windowStart;
      let text = "";
      for (let i = j; i < segments.length; i++) text += segments[i]!.text;
      text = text.slice(windowStart - offsets[j]!);
      const earlierOnly = text.slice(0, newStart - windowStart);
      // Matches the earlier posts already contain on their own: a token at the end of an earlier
      // post would otherwise "extend" into the first letters of the new post and hold it again.
      const already = new Set(scanText(earlierOnly).map((f) => `${f.rule}@${f.start}`));
      for (const f of scanText(text)) {
        const start = f.start + windowStart;
        const end = f.end + windowStart;
        if (end <= newStart) continue; // entirely in earlier posts
        if (start < newStart && already.has(`${f.rule}@${f.start}`)) continue;
        add(f.rule, f.value, splitRange(start, end, segments, offsets));
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

function splitRange(start: number, end: number, segments: Segment[], offsets: number[]): Range[] {
  const out: Range[] = [];
  segments.forEach((s, i) => {
    const a = offsets[i]!;
    const b = a + s.text.length;
    const lo = Math.max(start, a);
    const hi = Math.min(end, b);
    if (hi > lo) out.push({ segment: i, start: lo - a, end: hi - a });
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
