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
const MAX_DEPTH = 2;
// Standard and URL-safe alphabets in one class: '-' and '_' are mapped to '+' and '/' before decoding.
const BASE64_BLOCK = /[A-Za-z0-9+/_\-]{40,}={0,2}/g;
const PLAIN_ASCII = /^[\t\n\r\x20-\x7e]*$/;
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

/** A text to scan and a way to map its positions back to the raw input. */
interface Variant {
  text: string;
  name: string;
  depth: number;
  toRaw(start: number, end: number): [number, number];
}

function runRules(v: Variant, budget: Budget, out: Finding[]): void {
  budget.spend(v.text.length);
  const lower = v.text.toLowerCase();
  for (const rule of RULES) {
    if (!rule.keywords.some((k) => lower.includes(k))) continue;
    runRule(rule, v, out);
  }
}

function runRule(rule: Rule, v: Variant, out: Finding[]): void {
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
    const end = rule.extend ? rule.extend(m, v.text) : m.index + m[0].length;
    const [rs, re2] = v.toRaw(m.index, end);
    out.push({ rule: rule.id, start: rs, end: re2, value, variant: v.name });
  }
}

/** Removes invisible characters and applies NFKC per code point, keeping a position map. */
function normalizedVariant(raw: Variant): Variant | null {
  const text = raw.text;
  if (PLAIN_ASCII.test(text)) return null;
  let changed = false;
  const parts: string[] = [];
  const map: number[] = [];
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
      for (let k = 0; k < n.length; k++) map.push(i);
    }
    i += width;
  }
  if (!changed) return null;
  map.push(text.length);
  return {
    text: parts.join(""),
    name: `${raw.name}+normalized`,
    depth: raw.depth,
    toRaw: (s, e) => raw.toRaw(map[s] ?? text.length, map[e] ?? text.length),
  };
}

/** Decodes %XX runs as UTF-8, keeping a position map. */
function percentVariant(src: Variant): Variant | null {
  const text = src.text;
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return null;
  const parts: string[] = [];
  const map: number[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  let i = 0;
  while (i < text.length) {
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      const start = i;
      const bytes: number[] = [];
      while (i < text.length && text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 3;
      }
      const decoded = decoder.decode(new Uint8Array(bytes));
      parts.push(decoded);
      for (let k = 0; k < decoded.length; k++) map.push(start);
    } else {
      parts.push(text[i]!);
      map.push(i);
      i += 1;
    }
  }
  map.push(text.length);
  return {
    text: parts.join(""),
    name: `${src.name}+percent`,
    depth: src.depth,
    toRaw: (s, e) => src.toRaw(map[s] ?? text.length, map[e] ?? text.length),
  };
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
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (cp === 0xfffd) continue;
    if (cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp !== 127)) printable++;
  }
  return printable / Math.max(1, [...text].length) >= 0.85 ? text : null;
}

function base64Variants(src: Variant, budget: Budget): Variant[] {
  if (src.depth >= MAX_DEPTH) return [];
  const out: Variant[] = [];
  const seen = new Set<string>();
  BASE64_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BASE64_BLOCK.exec(src.text)) !== null) {
    const block = m[0];
    const start = m.index;
    const end = start + block.length;
    if (seen.has(`${start}:${end}`)) continue;
    seen.add(`${start}:${end}`);
    // Pure hex (hashes, git SHAs) is not base64 worth decoding.
    if (/^[0-9a-fA-F]+$/.test(block)) continue;
    const bytes = decodeBase64(block);
    if (!bytes) continue;
    budget.block(bytes.length);
    const text = printableText(bytes);
    if (!text) continue;
    const [rs, re] = src.toRaw(start, end);
    out.push({ text, name: `${src.name}+base64`, depth: src.depth + 1, toRaw: () => [rs, re] });
  }
  return out;
}

function scanVariant(v: Variant, budget: Budget, out: Finding[]): void {
  runRules(v, budget, out);
  const norm = normalizedVariant(v);
  if (norm) runRules(norm, budget, out);
  const base = norm ?? v;
  const pct = percentVariant(base);
  if (pct) runRules(pct, budget, out);
  for (const src of [base, ...(pct ? [pct] : [])]) {
    for (const decoded of base64Variants(src, budget)) scanVariant(decoded, budget, out);
  }
}

/**
 * Scans text for secrets. Throws ScanLimitError when the input or the work it causes is over
 * budget; callers must treat that, and any other error, as a match (fail closed).
 */
export function scanText(text: string, budget = new Budget()): Finding[] {
  if (text.length > MAX_SCAN_INPUT) throw new ScanLimitError("input size");
  const out: Finding[] = [];
  scanVariant({ text, name: "raw", depth: 0, toRaw: (s, e) => [s, e] }, budget, out);
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
