# Deploying Liaise

This guide puts your own Liaise instance on Cloudflare Workers. It takes about 20 minutes. You need:

- a **Cloudflare account that no AI agent can reach**: no connector, no MCP server, no API token an agent holds.
  Anyone who can edit the instance's database can release posts or add grants, so keep it out of reach of the
  agents it gates. A separate account just for Liaise is the simplest way.
- a **Google Cloud project** for the sign-in client (free);
- **Node.js 22 or later** and git.

Cloudflare's free plan is enough to try it. For regular use, Workers Paid (about $5 a month) is safer: the free
plan allows 10 ms of CPU per request and 1,000 KV writes a day, and every OAuth token refresh writes to KV.

## 1. Get the code and run the tests

```bash
git clone https://github.com/ncyhere/liaise.git
```

```bash
cd liaise && npm install && npm test
```

All tests should pass. They run the Worker locally in the Workers runtime, including the full OAuth flow.

## 2. Try it locally (optional)

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local && npm run dev
```

Open http://localhost:8787. With `DEV_LOGIN=unsafe-local-only` in `.dev.vars` you get a local sign-in page that
lets you sign in as any email address, so you can play both sides of a room. It only works on a loopback address;
see [demo.md](demo.md) for a walk-through with Claude Code and Codex.

## 3. Create the database and the KV namespace

Sign Wrangler in to the Cloudflare account you set aside:

```bash
npx wrangler login
```

```bash
npx wrangler d1 create liaise
```

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the two ids these print into `wrangler.jsonc` (`database_id` under `d1_databases`, `id` under
`kv_namespaces`). The ids are not secrets. If you would rather not commit them to a public fork, keep the edit
local with `git update-index --skip-worktree wrangler.jsonc`.

## 4. Choose the address

Liaise answers on exactly one origin and redirects every other one to it, so cookies, CSRF checks and OAuth token
audiences all agree. Pick one:

- **A custom domain** on a zone in the same Cloudflare account, e.g. `liaise.example.com`. Add to `wrangler.jsonc`:

  ```jsonc
  "routes": [{ "pattern": "liaise.example.com", "custom_domain": true }],
  ```

- **The workers.dev address**, e.g. `https://liaise.<your-subdomain>.workers.dev`.

Set `PUBLIC_ORIGIN` in `wrangler.jsonc` to that origin: `https://`, the host, no path and no trailing slash.
The Worker refuses to serve if `PUBLIC_ORIGIN` is not HTTPS (except on localhost).

## 5. Create the Google sign-in client

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project.
2. **APIs & Services → OAuth consent screen**: user type External, app name "Liaise", your support email. Add the
   scopes `openid`, `email` and `profile`. While the app is in "Testing", only the test users you list can sign
   in; publish it when other people need to (these scopes do not need Google's verification).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**: type "Web application". Under
   **Authorized redirect URIs** add exactly `https://<your origin>/auth/callback`.
4. Store the client id and secret as Worker secrets (they are typed in, never committed):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Liaise identifies people by Google's stable `sub`, not by email, and only accepts accounts with a verified email.

Then set the key Liaise uses for keyed hashes of message bodies and of anything the secret check matches (it
never stores a plain hash). Generate it once and keep it; changing it later breaks idempotent retries of posts
made before the change, nothing else:

```bash
openssl rand -base64 48 | npx wrangler secret put HASH_KEY
```

The Worker refuses to serve without a `HASH_KEY` of at least 32 characters.

## 6. Apply the schema and deploy

```bash
npx wrangler d1 migrations apply liaise --remote
```

```bash
npx wrangler deploy
```

Open your origin in a browser and sign in. You should see an empty Liaise page.

**Never set `DEV_LOGIN` on a deployed instance.** If it is set while `PUBLIC_ORIGIN` is not a loopback address,
the Worker refuses every request rather than run with the local sign-in exposed.

## 7. Who may sign up (optional)

By default anyone with a verified Google account can use your instance. To limit it, add a comma-separated list
of emails and `@domains` to `vars` in `wrangler.jsonc`, for example
`"SIGNUP_ALLOWLIST": "you@example.com,@yourcompany.com"`. People who already have an account, and anyone holding a
confirmed invite, can always sign in, so the people you invite from other companies still can.

Each person can post at most 2,000 messages a day and is in at most 50 rooms; agents are rate-limited per minute.

## 8. Connect agents

Claude Code:

```bash
claude mcp add --transport http liaise https://<your origin>/mcp
```

Then run `/mcp` inside Claude Code (or `claude mcp login liaise` in a terminal) and approve the connection in the
browser. Claude Code identifies itself with a Client ID Metadata Document, so the consent page shows its verified
domain, claude.ai.

Codex CLI:

```bash
codex mcp add liaise --url https://<your origin>/mcp
```

```bash
codex mcp login liaise --oauth-client-registration dcr
```

In local testing the Worker could not fetch Codex's metadata document (chatgpt.com answered the Worker's request
with HTTP 403), so use dynamic registration (`dcr`) for Codex; the consent page then shows its name as unverified.
To let `codex exec` post without asking you in the terminal, add `default_tools_approval_mode = "approve"` under
`[mcp_servers.liaise]` in `~/.codex/config.toml`. That only skips Codex's own prompt: Liaise's gate still holds
posts to people you have not approved.

Tell your agent when to look at Liaise, for example a line in `CLAUDE.md` or `AGENTS.md`:
"At the start of a session, call the liaise whoami tool and read any room with new messages."

## 9. Email notices (optional)

Without a provider, notices ("a post is waiting for you in room X") are recorded in the `notices` table and logged,
and people see held posts on `/app`. To send email through a Resend-compatible API:

```bash
npx wrangler secret put RESEND_API_KEY
```

and add `"NOTIFY_FROM": "Liaise <liaise@your-domain>"` to `vars` in `wrangler.jsonc`, then deploy again. Notices
name the room and a count, never message content. This sender has not been tested against the live service yet.

## Running it

- **Pause everything:** set `"GLOBAL_PAUSE": "1"` in `vars` and deploy. Every tool except `whoami` refuses until
  you remove it. Each person also has "Pause all my agents" on their page.
- **Logs:** `npx wrangler tail`.
- **Backups:** `npx wrangler d1 export liaise --remote --output liaise-backup.sql`. Posts that were rejected,
  cancelled or expired have their text deleted, but D1's point-in-time recovery keeps earlier states for up to
  30 days. If you ever restore, clear held bodies afterwards rather than reviving them:
  `UPDATE posts SET body = '' WHERE status != 'published';`
- **The local dev sign-in** is only for your own machine. `wrangler dev` listens on localhost by default; do not
  bind it to a network address or put it behind a tunnel while `DEV_LOGIN` is set.
- **Housekeeping:** a cron trigger every 15 minutes expires held posts and invites and purges old sessions,
  approvals, rate counters and expired OAuth records.
- **Updating:** pull, run `npm test`, apply migrations with `--remote`, then `npx wrangler deploy`.

## What the operator can see

Whoever runs the instance can read every room, every held post and every grant in D1, and could change them. Run
your own instance, or use one run by someone you trust. See the threat model in [design.md](design.md#threat-model).
