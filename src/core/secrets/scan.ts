import { RULES, RULES_VERSION, type Rule } from "./rules";

export { RULES_VERSION };

/** A match, with its span in the raw text that was scanned. */
export interface Finding {
  rule: string;
  start: number;
  end: number;
  /** The matched secret value. Never log, store or return this: hash it or mask it. */
  value: string;
  /** Which variant of the text matched: raw, normalized, percent, base64 (possibly nested). */
  variant: string;
}

export class ScanLimitError extends Error {
  constructor(what: string) {
    super(`secret scan limit reached: ${what}`);
  }
}

/** A fixed work budget per scan. Running out holds the post (fail closed). */
export class Budget {
  chars = 0;
  blocks = 0;
  decodedBytes = 0;
  constructor(
    readonly maxChars = 400_000,
    readonly maxBlocks = 256,
    readonly maxDecodedBytes = 160 * 1024,
  ) {}
  spend(chars: number): void {
    this.chars += chars;
    if (this.chars > this.maxChars) throw new ScanLimitError("characters");
  }
  block(bytes: number): void {
    this.blocks += 1;
    this.decodedBytes += bytes;
    if (this.blocks > this.maxBlocks) throw new ScanLimitError("encoded blocks");
    if (this.decodedBytes > this.maxDecodedBytes) throw new ScanLimitError("decoded bytes");
  }
}

export const MAX_SCAN_INPUT = 80 * 1024;
/** Base64 is decoded at most this many levels deep. */
const MAX_DEPTH = 2;
/** Any chain of transformations (normalize, percent, base64) is at most this long. */
const MAX_STEPS = 5;
const MAX_VARIANTS = 400;
// Standard and URL-safe alphabets in one class: '-' and '_' are mapped to '+' and '/' before decoding.
const BASE64_BLOCK = /[A-Za-z0-9+/_\-]{40,}={0,2}/g;
const PLAIN_ASCII = /^[\t\n\r\x20-\x7e]*$/;
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
const HEX2 = /^[0-9A-Fa-f]{2}$/;

/** A text to scan and a way to map a span of it back to a non-empty span of the raw input. */
interface Variant {
  text: string;
  name: string;
  b64depth: number;
  steps: number;
  toRaw(start: number, end: number): [number, number];
}

function runRules(v: Variant, budget: Budget, out: Finding[]): void {
  budget.spend(v.text.length);
  const lower = v.text.toLowerCase();
  for (const rule of RULES) {
    if (!rule.keywords.some((k) => lower.includes(k))) continue;
    runRule(rule, v, out, budget);
  }
}

function runRule(rule: Rule, v: Variant, out: Finding[], budget: Budget): void {
  const re = rule.regex;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v.text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const value = m.groups?.v ?? m[0];
    if (rule.validate && !rule.validate(value, m, v.text)) continue;
    const end = rule.extend ? rule.extend(m, v.text, budget) : m.index + m[0].length;
    const [rs, re2] = v.toRaw(m.index, end);
    out.push({ rule: rule.id, start: rs, end: Math.max(re2, rs + 1), value, variant: v.name });
  }
}

/**
 * A child variant whose characters each come from a known [start, end) span of the parent, so a
 * match maps back to a non-empty raw span.
 */
function child(parent: Variant, text: string, starts: number[], ends: number[], name: string, b64depth = parent.b64depth): Variant {
  const last = parent.text.length;
  return {
    text,
    name: `${parent.name}+${name}`,
    b64depth,
    steps: parent.steps + 1,
    toRaw: (s, e) => {
      const a = starts[s] ?? last;
      const b = ends[Math.max(s, e - 1)] ?? last;
      return parent.toRaw(a, Math.max(b, a + 1));
    },
  };
}

/** Removes invisible characters and applies NFKC per code point. */
function normalizedVariant(v: Variant): Variant | null {
  const text = v.text;
  if (PLAIN_ASCII.test(text)) return null;
  let changed = false;
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const width = ch.length;
    if (INVISIBLE.test(ch)) {
      changed = true;
    } else {
      const n = cp < 0x80 ? ch : ch.normalize("NFKC");
      if (n !== ch) changed = true;
      parts.push(n);
      for (let k = 0; k < n.length; k++) {
        starts.push(i);
        ends.push(i + width);
      }
    }
    i += width;
  }
  return changed ? child(v, parts.join(""), starts, ends, "normalized") : null;
}

const encoder = new TextEncoder();

/** Decodes %XX runs as UTF-8. Each decoded character maps to the %XX triples that produced it. */
function percentVariant(v: Variant): Variant | null {
  const text = v.text;
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return null;
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  let i = 0;
  while (i < text.length) {
    if (text[i] === "%" && HEX2.test(text.slice(i + 1, i + 3))) {
      const runStart = i;
      const bytes: number[] = [];
      while (i < text.length && text[i] === "%" && HEX2.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 3;
      }
      const decoded = decoder.decode(new Uint8Array(bytes));
      parts.push(decoded);
      // Byte offsets per decoded code point; if invalid UTF-8 made them disagree, map to the whole run.
      const cps = [...decoded];
      const lens = cps.map((c) => (c === "�" ? 1 : encoder.encode(c).length));
      const exact = lens.reduce((a, b) => a + b, 0) === bytes.length;
      let byte = 0;
      cps.forEach((c, k) => {
        const s = exact ? runStart + 3 * byte : runStart;
        const e = exact ? runStart + 3 * (byte + lens[k]!) : i;
        for (let u = 0; u < c.length; u++) {
          starts.push(s);
          ends.push(e);
        }
        byte += lens[k]!;
      });
    } else {
      parts.push(text[i]!);
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }
  return child(v, parts.join(""), starts, ends, "percent");
}

function decodeBase64(block: string): Uint8Array | null {
  let b = block.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (b.length % 4 === 1) b = b.slice(0, -1);
  b += "=".repeat((4 - (b.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Mostly printable UTF-8 text, so binary data (images, compressed blobs) is not scanned as text. */
function printableText(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  let printable = 0;
  let total = 0;
  for (const c of text) {
    total++;
    const cp = c.codePointAt(0)!;
    if (cp === 0xfffd) continue;
    if (cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp !== 127)) printable++;
  }
  return printable / Math.max(1, total) >= 0.85 ? text : null;
}

/** Decoded base64 blocks: every character maps to the whole encoded block. */
function base64Variants(v: Variant, budget: Budget): Variant[] {
  if (v.b64depth >= MAX_DEPTH) return [];
  const out: Variant[] = [];
  BASE64_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BASE64_BLOCK.exec(v.text)) !== null) {
    const block = m[0];
    // Pure hex (hashes, git SHAs) is not base64 worth decoding.
    if (/^[0-9a-fA-F]+$/.test(block)) continue;
    const bytes = decodeBase64(block);
    if (!bytes) continue;
    budget.block(bytes.length);
    const text = printableText(bytes);
    if (!text) continue;
    const start = m.index;
    const end = start + block.length;
    out.push({
      text,
      name: `${v.name}+base64`,
      b64depth: v.b64depth + 1,
      steps: v.steps + 1,
      toRaw: () => v.toRaw(start, end),
    });
  }
  return out;
}

/**
 * Every variant is scanned and then expanded with every applicable transformation (normalize,
 * percent-decode, base64-decode), so combinations such as percent-encoded full-width text are
 * covered. Chains are bounded in length and the whole scan shares one work budget.
 */
function scanAll(root: Variant, budget: Budget, out: Finding[]): void {
  const queue: Variant[] = [root];
  const seen = new Set<string>();
  let variants = 0;
  while (queue.length > 0) {
    const v = queue.shift()!;
    if (seen.has(v.text)) continue;
    seen.add(v.text);
    if (++variants > MAX_VARIANTS) throw new ScanLimitError("variants");
    runRules(v, budget, out);
    if (v.steps >= MAX_STEPS) continue;
    const n = normalizedVariant(v);
    if (n) queue.push(n);
    const p = percentVariant(v);
    if (p) queue.push(p);
    queue.push(...base64Variants(v, budget));
  }
}

/**
 * Scans text for secrets. Throws ScanLimitError when the input or the work it causes is over
 * budget; callers must treat that, and any other error, as a match (fail closed).
 */
export function scanText(text: string, budget = new Budget()): Finding[] {
  if (text.length > MAX_SCAN_INPUT) throw new ScanLimitError("input size");
  const out: Finding[] = [];
  scanAll({ text, name: "raw", b64depth: 0, steps: 0, toRaw: (s, e) => [s, e] }, budget, out);
  // One finding per rule and span.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.rule}:${f.start}:${f.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The display form of a matched value: first 6 and last 4 characters, the rest hidden. */
export function maskValue(v: string): string {
  if (v.length < 14) return "•".repeat(Math.max(4, v.length));
  return `${v.slice(0, 6)}${"•".repeat(Math.min(12, v.length - 10))}${v.slice(-4)}`;
}
