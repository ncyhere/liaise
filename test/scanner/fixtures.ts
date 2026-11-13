/**
 * Fake secrets, generated at run time from a seeded PRNG so no realistic token is ever written
 * into the repository (where push protection and secret scanners would rightly object).
 */
let seed = 0x5eed1234;
function rand(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
export const alnum = (n: number) => pick(ALNUM, n);
export const hex = (n: number) => pick("0123456789abcdef", n);
export const upper = (n: number) => pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", n);
export const b64url = (n: number) => pick(ALNUM + "-_", n);
export const b64 = (s: string) => btoa(s);
export const b64urlOf = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const j = (...parts: string[]) => parts.join("");

export function pem(kind: string): string {
  const lines = Array.from({ length: 12 }, () => pick(ALNUM + "+/", 64));
  return `-----BEGIN ${kind}PRIVATE KEY-----\n${lines.join("\n")}\n-----END ${kind}PRIVATE KEY-----`;
}

/** [name, text, expected rule] — every one must be caught. */
export function mustCatch(): [string, string, string][] {
  const anthropic = j("sk-", "ant-", "api03-", b64url(93), "AA");
  const ghp = j("gh", "p_", alnum(36));
  const aws = j("AK", "IA", upper(16));
  const stripe = j("sk", "_live_", alnum(24));
  const jwt = j(b64urlOf('{"alg":"HS256","typ":"JWT"}'), ".", b64urlOf(`{"sub":"${alnum(8)}","exp":1999999999}`), ".", b64url(43));
  const envLine = j("DATABASE_PASSWORD=", alnum(12), "-", alnum(12));
  const fullwidth = [...anthropic].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
  return [
    ["anthropic", `Here is the key: ${anthropic} — use it for the test.`, "anthropic-api-key"],
    ["openai project", j("OPENAI key ", "sk-", "proj-", b64url(74), "T3Blbk", "FJ", b64url(74)), "openai-api-key"],
    ["openai legacy", j("sk-", alnum(20), "T3Blbk", "FJ", alnum(20)), "openai-api-key"],
    ["aws access key id", `aws_access_key_id = ${aws}`, "aws-access-key-id"],
    ["aws secret in env", j("export AWS_SECRET_ACCESS_KEY=", pick(ALNUM + "/+", 40)), "secret-assignment"],
    ["github classic", `token ${ghp}`, "github-token"],
    ["github fine-grained", j("github", "_pat_", alnum(22), "_", alnum(59)), "github-fine-grained-pat"],
    ["gitlab", j("gl", "pat-", b64url(20)), "gitlab-token"],
    ["slack bot", j("xo", "xb-", pick("0123456789", 12), "-", pick("0123456789", 13), "-", alnum(24)), "slack-token"],
    ["slack webhook", j("https://hooks.", "slack.com/services/T", upper(10), "/B", upper(10), "/", alnum(24)), "slack-webhook-url"],
    ["stripe", `STRIPE: ${stripe}`, "stripe-secret-key"],
    ["google api key", j("AI", "za", b64url(35)), "google-api-key"],
    ["google oauth secret", j("GOC", "SPX-", b64url(28)), "google-oauth-client-secret"],
    ["npm", j("np", "m_", alnum(36)), "npm-token"],
    ["sendgrid", j("SG", ".", b64url(22), ".", b64url(43)), "sendgrid-api-key"],
    ["huggingface", j("h", "f_", pick("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 34)), "huggingface-token"],
    ["shopify", j("shp", "at_", hex(32)), "shopify-token"],
    ["digitalocean", j("do", "p_v1_", hex(64)), "digitalocean-token"],
    ["groq", j("gs", "k_", alnum(52)), "groq-api-key"],
    ["rsa private key", pem("RSA "), "private-key"],
    ["openssh private key", pem("OPENSSH "), "private-key"],
    [
      "service account json",
      JSON.stringify({ type: "service_account", project_id: "demo", private_key: pem("") + "\n", client_email: "x@demo.iam.gserviceaccount.com" }),
      "private-key",
    ],
    ["jwt", `Authorization: Bearer ${jwt}`, "jwt"],
    ["url with password", j("postgres://app_user:", alnum(20), "@db.internal:5432/prod"), "url-with-password"],
    [".env password", envLine, "secret-assignment"],
    [".env token", j("CLOUDFLARE_API_TOKEN=", b64url(40)), "secret-assignment"],
    ["json client_secret", j('{"client_id": "abc", "client_secret": "', alnum(32), '"}'), "secret-assignment"],
    ["camelCase key in code", j('const stripeSecretKey = "', alnum(32), '";'), "secret-assignment"],
    ["yaml password", j("db:\n  password: ", alnum(10), "!", alnum(10)), "secret-assignment"],
    ["base64 of a .env line", `config: ${b64(envLine + "\n")}`, "secret-assignment"],
    ["base64url of a token", b64urlOf(`key=${anthropic}`), "anthropic-api-key"],
    ["double base64", b64(b64(`deploy with ${ghp} please`)), "github-token"],
    ["zero-width split", [...anthropic].join("​"), "anthropic-api-key"],
    ["fullwidth characters", fullwidth, "anthropic-api-key"],
    ["percent-encoded", [...stripe].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""), "stripe-secret-key"],
    ["inside a code fence", "```bash\n" + j("export GITHUB_TOKEN=", ghp) + "\n```", "github-token"],
  ];
}

/** [name, text] — none of these may be caught. */
export function mustPass(): [string, string][] {
  const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + Array.from({ length: 1500 }, () => String.fromCharCode(Math.floor(rand() * 256))).join("");
  return [
    ["git sha", `Fixed in commit ${hex(40)} and ${hex(7)}.`],
    ["sha256", `sha256: ${hex(64)}`],
    ["docker digest", `image: liaise@sha256:${hex(64)}`],
    ["uuids", Array.from({ length: 5 }, () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`).join(", ")],
    ["npm integrity", `"integrity": "sha512-${b64(Array.from({ length: 64 }, () => String.fromCharCode(Math.floor(rand() * 256))).join(""))}"`],
    ["base64 png", `![chart](data:image/png;base64,${b64(png)})`],
    ["prose", "Please rotate the API key, keep the token in the secret manager, and remember the password policy needs 12 characters."],
    ["env reference", "const apiKey = process.env.OPENAI_API_KEY;\nSECRET_KEY = os.environ['SECRET_KEY']"],
    ["placeholders", "API_KEY=your_api_key_here\nDB_PASSWORD=<password>\nTOKEN=${GITHUB_TOKEN}\nSECRET=changeme\nCLIENT_SECRET=xxxxxxxxxxxxxxxx"],
    ["github actions", "token: ${{ secrets.GITHUB_TOKEN }}"],
    ["model settings", '{"max_tokens": 4096, "tokenizer": "cl100k_base", "temperature": 0.2}'],
    ["aws documentation key", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["jwt.io sample", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ["stripe publishable key", `pk_live_${alnum(24)}`],
    ["url with placeholder password", "postgres://user:password@localhost:5432/db and https://user:${PASSWORD}@example.com"],
    ["plain url", `https://example.com/docs/api?page=2&sort=desc#section-${alnum(6)}`],
    ["k8s secret name", "tls:\n  secretName: my-tls-secret\n  secretKeyRef: api-credentials"],
    ["private key header in docs", "Paste the file that starts with -----BEGIN PRIVATE KEY----- into the field."],
    ["long words", "Supercalifragilisticexpialidocious ".repeat(40)],
    ["markdown table of hashes", `| file | sha1 |\n|---|---|\n| a.txt | ${hex(40)} |\n| b.txt | ${hex(40)} |`],
  ];
}

/** About 16 KB of realistic agent text: prose, code, hashes, a URL or two. */
export function realisticPost(): string {
  const chunk = [
    "Here is the proposal for the stock sync API. GET /v1/stock?sku=ABC-123 returns the current quantity.",
    "```ts\nexport async function adjust(sku: string, delta: number) {\n  const res = await fetch(`${BASE}/v1/stock/adjustments`, { method: 'POST' });\n  return res.json();\n}\n```",
    `Commit ${hex(40)} added idempotency keys; see https://example.com/pr/${alnum(6)} for the review.`,
    `| sku | qty | updated |\n|---|---|---|\n| ABC-${hex(4)} | 42 | 2026-11-13 |`,
    "We keep keys for 24 hours. Negative stock returns 409 with error code stock_negative.",
  ].join("\n\n");
  let s = "";
  while (s.length < 16 * 1024) s += chunk + "\n\n";
  return s.slice(0, 16 * 1024);
}

/** Inputs built to make a backtracking regex engine work hard. */
export function adversarial(): [string, string][] {
  const n = 16 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  return [
    ["letters", fill("a")],
    ["capitals", fill("A")],
    ["anthropic prefixes", fill("sk-ant-api03-")],
    ["jwt starts", fill("eyJ")],
    ["jwt parts", fill("eyJaaaaaaaaaaaaaaaa.")],
    ["key headers", fill("-----BEGIN RSA PRIVATE KEY-----")],
    ["assignments", fill("api_key=")],
    ["long assignment names", fill("a_secret_token_name_that_goes_on_and_on_and_on_")],
    ["schemes", fill("ab://")],
    ["userinfo", "postgres://" + fill("u:")],
    ["percent runs", fill("%41")],
    ["base64 of base64", btoa(btoa(fill("x").slice(0, 6000)))],
    ["many short base64 blocks", fill("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn ")],
    ["fullwidth", fill("ｓｋ－ａｎｔ－")],
    ["dashes", fill("-")],
    ["equals", fill("=")],
  ];
}
