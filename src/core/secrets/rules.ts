/**
 * Secret-detection rules. Many are adapted from gitleaks' default rules (MIT; see GITLEAKS-LICENSE
 * in this folder for its notice). Liaise's versions are rewritten to be safe on a backtracking
 * regex engine:
 *
 * - every quantifier is bounded, or its run is taken "atomically" with the lookahead trick
 *   `(?=(X{a,b}))\N`, which cannot be backtracked into;
 * - a rule starts only at a token boundary (lookbehind), so a long run of letters is tried once,
 *   not at every offset;
 * - each rule has lower-case keywords, and its regex runs only when one appears in the text.
 *
 * Bump RULES_VERSION whenever a rule changes: a held post records the version it was held under.
 */
export const RULES_VERSION = "2026-11-13.1";

export interface Rule {
  id: string;
  /** At least one must occur in the lower-cased text for the regex to run. */
  keywords: string[];
  /** Global regex. If it has a group named `v`, that group is the secret value. */
  regex: RegExp;
  /** Extra checks on the value (entropy, placeholders, public examples). */
  validate?: (value: string, match: RegExpExecArray, text: string) => boolean;
  /** Extend the reported span past the regex match (e.g. to the end of a key block). */
  extend?: (match: RegExpExecArray, text: string, budget: { spend(chars: number): void }) => number;
}

/** "-----END" positions in a text, found in one pass and reused for every key header in it. */
let endIndexText: string | null = null;
let endIndex: number[] = [];
function nextEndMarker(text: string, from: number, budget: { spend(chars: number): void }): number {
  if (endIndexText !== text) {
    budget.spend(text.length);
    endIndex = [];
    for (let i = text.indexOf("-----END"); i >= 0; i = text.indexOf("-----END", i + 8)) endIndex.push(i);
    endIndexText = text;
  }
  let lo = 0;
  let hi = endIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endIndex[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < endIndex.length ? endIndex[lo]! : -1;
}

/** Not preceded by a token character. */
const B = "(?<![A-Za-z0-9_\\-])";
/** Not followed by a token character. */
const E = "(?![A-Za-z0-9_\\-])";

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const k of counts.values()) {
    const p = k / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(s: string): number {
  return (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0) + (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
}

const PLACEHOLDER =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\{\{[^}]*\}\}|%[A-Za-z_]+%|[x*.•_\-]{3,}|(?:your|my|the|insert|enter|replace|put)[_\-]?.*|.*(?:here|example|placeholder|changeme|redacted|dummy|sample|fake|xxxx).*|null|none|true|false|undefined|process\.env\..*|os\.environ.*|env\..*|secrets\..*)$/i;

const DOTTED_REFERENCE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/** A value that looks like a real random secret rather than a word, reference or placeholder. */
export function looksRandom(value: string, minLength = 16): boolean {
  const v = value.replace(/^["'`]|["'`]$/g, "");
  if (v.length < minLength) return false;
  if (PLACEHOLDER.test(v) || DOTTED_REFERENCE.test(v)) return false;
  if (/^(?:\/|\.\/|~\/|[A-Za-z]:\\)/.test(v) || v.includes("://")) return false;
  if (/^\d+$/.test(v)) return false;
  // Publishable keys are meant to be public.
  if (/^pk_(?:live|test)_/.test(v)) return false;
  // Words joined by dashes ("one-million-per-day") are settings, not secrets: want a digit, mixed
  // case, or real length.
  const hasDigit = /[0-9]/.test(v);
  const mixedCase = /[a-z]/.test(v) && /[A-Z]/.test(v);
  if (!hasDigit && !mixedCase && v.length < 32) return false;
  return charClasses(v) >= 2 && shannonEntropy(v) >= 3.0;
}

/** Variable names that suggest a secret: *_KEY, *TOKEN*, *SECRET*, *PASSWORD* and close relatives. */
export function secretishName(name: string): boolean {
  const n = name.replace(/^["']|["']$/g, "");
  // Public halves and settings about secrets, not secrets: STRIPE_PUBLISHABLE_KEY, TOKEN_BUDGET, KEY_ID, SECRET_NAME.
  if (/publishable|public/i.test(n)) return false;
  if (/(?:^|[_.\-]|[a-z])(?:budget|limit|count|max|min|ttl|expiry|expires|lifetime|length|size|url|uri|endpoint|type|name|id|file|path|header|prefix|format|algorithm|alg|version|timeout|region|issuer|audience|scope)s?$/i.test(n)) return false;
  if (/(?:^|[_.\-])key$/i.test(n) || /[a-z0-9]Key$/.test(n) || /^(?:api|private|secret|access|auth)[_.\-]?key/i.test(n)) return true;
  if (/token/i.test(n) && !/^(?:max|num|n|total|count|input|output)?_?tokens?$/i.test(n) && !/tokeniz/i.test(n)) return true;
  if (/secret/i.test(n) && !/secret[_.\-]?(?:name|ref|id|arn|path|version)$/i.test(n)) return true;
  if (/passw(?:or)?d|(?:^|[_.\-])pwd(?:$|[_.\-])|passphrase|credential/i.test(n)) return true;
  return false;
}

const AWS_EXAMPLE_IDS = new Set(["AKIAIOSFODNN7EXAMPLE", "AKIAI44QH8DHBEXAMPLE"]);
const JWT_IO_SAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const PASSWORD_PLACEHOLDER =
  /^(?:\*+|x+|\.+|•+|password|passwd|pass|pwd|secret|pw|your[_\-]?password|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_]+|%[A-Za-z_]+%|\[[^\]]*\])$/i;

function token(id: string, keywords: string[], body: string, validate?: Rule["validate"]): Rule {
  return { id, keywords, regex: new RegExp(`${B}${body}`, "g"), validate };
}

export const RULES: Rule[] = [
  token("anthropic-api-key", ["sk-ant-"], `sk-ant-(?:api|admin|oat|sid)\\d{2}-[A-Za-z0-9_\\-]{40,200}`),
  token("openai-api-key", ["sk-proj-", "sk-svcacct-", "sk-admin-"], `sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\\-]{40,250}`),
  token("openai-api-key", ["t3blbkfj"], `sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}${E}`),
  token(
    "aws-access-key-id",
    ["akia", "asia", "abia", "acca", "a3t"],
    `(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}${E}`,
    (v) => !AWS_EXAMPLE_IDS.has(v) && !v.endsWith("EXAMPLE"),
  ),
  token("github-token", ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], `gh[pousr]_[A-Za-z0-9]{36}${E}`),
  token("github-fine-grained-pat", ["github_pat_"], `github_pat_[A-Za-z0-9_]{60,120}`),
  token("gitlab-token", ["glpat-", "glptt-", "gldt-"], `gl(?:pat|ptt|dt)-[A-Za-z0-9_\\-]{20,80}`),
  token("slack-token", ["xoxb-", "xoxp-", "xoxa-", "xoxo-", "xoxs-", "xoxr-", "xoxe-"], `xox[abposre]-[A-Za-z0-9\\-]{10,250}`),
  {
    id: "slack-webhook-url",
    keywords: ["hooks.slack.com"],
    regex: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/+\-]{20,250}/g,
  },
  token("stripe-secret-key", ["sk_live_", "sk_test_", "sk_prod_", "rk_live_", "rk_test_", "rk_prod_"], `[sr]k_(?:live|test|prod)_[A-Za-z0-9]{10,250}`),
  token("google-api-key", ["aiza"], `AIza[A-Za-z0-9_\\-]{35}${E}`),
  token("google-oauth-client-secret", ["gocspx-"], `GOCSPX-[A-Za-z0-9_\\-]{28}${E}`),
  token("cloudflare-origin-ca-key", ["v1.0-"], `v1\\.0-[a-f0-9]{24}-[a-f0-9]{146}${E}`),
  token("npm-token", ["npm_"], `npm_[A-Za-z0-9]{36}${E}`),
  token("pypi-token", ["pypi-ageichlwas5vcmc"], `pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\\-]{50,400}`),
  token("sendgrid-api-key", ["sg."], `SG\\.[A-Za-z0-9_\\-]{22}\\.[A-Za-z0-9_\\-]{43}${E}`),
  token("huggingface-token", ["hf_"], `hf_[A-Za-z]{34}${E}`),
  token("twilio-api-key", ["sk"], `SK[0-9a-fA-F]{32}${E}`),
  token("shopify-token", ["shpat_", "shpss_", "shpca_", "shppa_"], `shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}${E}`),
  token("digitalocean-token", ["_v1_"], `do[opr]_v1_[a-f0-9]{64}${E}`),
  token("databricks-token", ["dapi"], `dapi[a-f0-9]{32}(?:-\\d)?${E}`),
  token("groq-api-key", ["gsk_"], `gsk_[A-Za-z0-9]{52}${E}`),
  token("xai-api-key", ["xai-"], `xai-[A-Za-z0-9]{80}${E}`),
  token("linear-api-key", ["lin_api_"], `lin_api_[A-Za-z0-9]{40}${E}`),
  token("notion-token", ["secret_", "ntn_"], `(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,50})${E}`),
  token("postman-api-key", ["pmak-"], `PMAK-[a-f0-9]{24}-[a-f0-9]{34}${E}`),
  token("vault-token", ["hvs.", "hvb."], `hv[sb]\\.[A-Za-z0-9_\\-]{24,250}`),
  token("atlassian-api-token", ["atatt3"], `ATATT3[A-Za-z0-9_\\-=]{150,250}`),
  token("mailgun-api-key", ["key-"], `key-[0-9a-f]{32}${E}`),
  {
    id: "private-key",
    keywords: ["private key"],
    regex: /-----BEGIN[ A-Z0-9_\-]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
    // A header alone (in docs or code) is not a key: require key material right after it.
    validate: (_v, m, text) => /[A-Za-z0-9+/]{40}/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 600)),
    extend: (m, text, budget) => {
      const start = m.index + m[0].length;
      const end = nextEndMarker(text, start, budget);
      if (end >= 0 && end - start < 20000) {
        const close = text.lastIndexOf("-----", Math.min(text.length, end + 80));
        return close > end ? close + 5 : end + 8;
      }
      return Math.min(text.length, start + 600);
    },
  },
  {
    id: "jwt",
    keywords: ["eyj"],
    // Atomic runs: each part is captured by a lookahead and consumed by a back-reference.
    regex: new RegExp(
      `${B}(?<v>eyJ(?=([A-Za-z0-9_\\-]{10,4000}))\\2\\.eyJ(?=([A-Za-z0-9_\\-]{10,4000}))\\3\\.(?=([A-Za-z0-9_\\-]{10,4000}))\\4)`,
      "g",
    ),
    validate: (v) => v !== JWT_IO_SAMPLE,
  },
  {
    id: "url-with-password",
    keywords: ["://"],
    regex:
      /(?<![A-Za-z0-9+.\-])[A-Za-z][A-Za-z0-9+.\-]{1,20}:\/\/(?=([^\s:/@"'<>`]{1,100}))\1:(?=(?<v>[^\s/@"'<>`]{3,200}))\2@[^\s/"'<>`:]{1,200}/g,
    validate: (v) => !PASSWORD_PLACEHOLDER.test(v),
  },
  {
    id: "secret-assignment",
    keywords: ["key", "token", "secret", "passw", "pwd", "passphrase", "credential"],
    // NAME = value, NAME: value, "name": "value", NAME := value, name => value.
    regex:
      /(?<![A-Za-z0-9_.\-])["']?(?<n>[A-Za-z_][A-Za-z0-9_.\-]{0,80})["']?[ \t]{0,8}(?::=|=>|=|:)[ \t]{0,8}["'`]?(?=(?<v>[^\s"'`;,<>(){}[\]]{8,300}))\k<v>/g,
    validate: (v, m) => secretishName(m.groups?.n ?? "") && looksRandom(v),
  },
];
