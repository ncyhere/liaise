/** HTML that is already safe. Only produced by `html` and `raw`. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return esc(value);
}

/** Tagged template: every interpolated value is escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new SafeHtml(out);
}

/** Only for constant markup written in this codebase. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

const CSS = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#fbfbfa;--card:#fff;--line:#e3e3e0;--accent:#2f5d50;--warn:#9a5b00;--bad:#a12a2a}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a0a0a5;--bg:#161616;--card:#1f1f1f;--line:#333;--accent:#8cc5b0;--warn:#e0a85a;--bad:#ef8b8b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:20px}
header.top a.brand{font-weight:650;color:var(--fg);text-decoration:none;letter-spacing:.01em}
h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:28px 0 10px}h3{font-size:15px;margin:0 0 6px}
a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:10px 0}
.muted{color:var(--muted)}.small{font-size:13px}.warn{color:var(--warn)}.bad{color:var(--bad)}
.body{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px;overflow:auto}
.msg{border-left:3px solid var(--line);padding:4px 0 4px 12px;margin:10px 0}.msg.system{border-color:var(--accent)}
form.inline{display:inline}
button,input[type=submit]{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}button.danger{color:var(--bad)}
input[type=text],input[type=email],textarea,select{font:inherit;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
textarea{min-height:70px}label{display:block;margin:8px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px}
`;

export interface PageOptions {
  status?: number;
  /** Extra `form-action` sources, e.g. an OAuth client's redirect origin on the consent page. */
  formAction?: string[];
  headers?: Record<string, string>;
  refreshSeconds?: number;
  signedInEmail?: string | null;
  csrf?: string | null;
}

export function securityHeaders(formAction: string[] = []): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self'",
      `form-action 'self'${formAction.length ? " " + formAction.join(" ") : ""}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on form posts,
    // which would defeat the exact-Origin check. Other sites still get no referrer.
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "cache-control": "no-store",
  };
}

export function page(title: string, body: SafeHtml, opts: PageOptions = {}): Response {
  const doc = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${opts.refreshSeconds ? html`<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${title === "Liaise" ? title : `${title} · Liaise`}</title><style>${raw(CSS)}</style></head>
<body><main>
<header class="top"><a class="brand" href="/app">Liaise</a>
${
  opts.signedInEmail
    ? html`<span class="row small muted">${opts.signedInEmail}
        <form class="inline" method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${opts.csrf ?? ""}"><button>Sign out</button></form></span>`
    : ""
}
</header>
${body}
</main></body></html>`;
  return new Response(doc.value, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders(opts.formAction), ...(opts.headers ?? {}) },
  });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

export function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86400)} d`;
}

export function when(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
