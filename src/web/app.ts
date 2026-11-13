import type { Env } from "../env";
import { createApproval } from "../core/approvals";
import { LiaiseError } from "../core/errors";
import {
  acceptInvite,
  confirmInvite,
  declineInvite,
  inviteByToken,
  inviteByTokenHash,
  inviteForInviter,
  invitesFor,
  proposeInvite,
  relinkInvite,
  revokeInvite,
  type InviteForInvitee,
} from "../core/invites";
import { LIMITS } from "../core/model";
import { listConnections, revokeConnection, setConnectionPaused, setConnectionTrust, setPersonPaused } from "../core/people";
import { bindingFor, decideHeld, heldDetail, listHeldFor, setHoldEveryPost, visibleMessages, type VisibleMessage } from "../core/posts";
import { decideRequest, pendingRequestsFor, removeAllowlistEntry, removeRoomGrant } from "../core/requests";
import { coverageSources, listRoomsFor, membersOf, roomForMember } from "../core/rooms";
import type { MaskedPart } from "../core/secrets/check";
import { emailDomain, now } from "../core/util";
import { loginUrl } from "./auth";
import { ago, html, page, redirect, when, type SafeHtml } from "./html";
import { checkedForm, getSession, isFresh, type WebSession } from "./session";

type Ctx = { waitUntil(p: Promise<unknown>): void };

const STATUS_FOR: Partial<Record<LiaiseError["code"], number>> = {
  not_found: 404,
  forbidden: 403,
  fresh_sign_in_required: 403,
  rate_limited: 429,
};

function errorPage(e: LiaiseError, session: WebSession | null): Response {
  return page(
    "Could not do that",
    html`<h1>Could not do that</h1><p>${e.message}</p><p><a href="/app">Back to Liaise</a></p>`,
    { status: STATUS_FOR[e.code] ?? 400, signedInEmail: session?.person.email, csrf: session?.csrf },
  );
}

function notAllowed(session: WebSession): Response {
  return page("Not allowed", html`<h1>That request was not allowed</h1><p>Reload the page and try again.</p>`, {
    status: 403,
    signedInEmail: session.person.email,
    csrf: session.csrf,
  });
}

/** Routes under /app and /join. Every route needs a browser session; MCP tokens never reach here. */
export async function handleApp(request: Request, env: Env, url: URL, ctx: Ctx): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    if (request.method === "GET") return redirect(loginUrl(url.pathname + url.search));
    return page("Signed out", html`<h1>You are signed out</h1><p><a href="${loginUrl("/app")}">Sign in</a></p>`, { status: 401 });
  }
  const p = url.pathname;
  const m = (re: RegExp) => re.exec(p);
  try {
    let r: RegExpExecArray | null;
    if (p === "/app" || p === "/app/") return await dashboard(env, session);
    if (p === "/app/pause") return await pauseAll(request, env, session);
    if ((r = m(/^\/app\/rooms\/([a-z0-9_]{1,64})$/))) return await roomPage(env, session, r[1]!);
    if ((r = m(/^\/app\/rooms\/([a-z0-9_]{1,64})\/invite$/))) return await roomInvite(request, env, session, r[1]!);
    if ((r = m(/^\/app\/rooms\/([a-z0-9_]{1,64})\/grants\/([a-z0-9_]{1,64})\/remove$/))) return await grantRemove(request, env, session, r[1]!, r[2]!);
    if ((r = m(/^\/app\/rooms\/([a-z0-9_]{1,64})\/allowlist\/([a-z0-9_]{1,64})\/remove$/))) return await allowlistRemove(request, env, session, r[1]!, r[2]!);
    if ((r = m(/^\/app\/rooms\/([a-z0-9_]{1,64})\/hold-every-post$/))) return await holdEveryPost(request, env, session, r[1]!);
    if ((r = m(/^\/app\/held\/([a-z0-9_]{1,64})$/))) {
      return request.method === "POST" ? await heldDecide(request, env, session, r[1]!) : await heldPage(env, session, r[1]!);
    }
    if ((r = m(/^\/app\/invites\/([a-z0-9_]{1,64})$/))) return await invitePage(env, session, r[1]!);
    if ((r = m(/^\/app\/invites\/([a-z0-9_]{1,64})\/(confirm|revoke|relink)$/))) return await inviteAction(request, env, session, r[1]!, r[2]!);
    if ((r = m(/^\/app\/accept\/([a-z0-9_]{1,64})$/))) return await joinById(request, env, session, r[1]!, ctx);
    if ((r = m(/^\/join\/([A-Za-z0-9_\-]{20,100})$/))) return await joinByToken(request, env, session, r[1]!, ctx);
    if ((r = m(/^\/app\/requests\/([a-z0-9_]{1,64})$/))) return await requestDecide(request, env, session, r[1]!);
    if ((r = m(/^\/app\/connections\/([a-z0-9_]{1,64})$/))) return await connectionAction(request, env, session, r[1]!);
  } catch (e) {
    if (e instanceof LiaiseError) return errorPage(e, session);
    throw e;
  }
  return page("Not found", html`<h1>Not found</h1>`, { status: 404, signedInEmail: session.person.email, csrf: session.csrf });
}

const csrfField = (s: WebSession) => html`<input type="hidden" name="csrf" value="${s.csrf}">`;
const opts = (s: WebSession, extra: Record<string, unknown> = {}) => ({ signedInEmail: s.person.email, csrf: s.csrf, ...extra });

function who(name: string | null, email: string | null): SafeHtml {
  if (!email) return html`<span class="muted">Liaise</span>`;
  return html`<strong>${name || email}</strong>${name ? html` <span class="muted small">${email}</span>` : ""}`;
}

function messageView(msg: VisibleMessage): SafeHtml {
  if (msg.kind === "system") return html`<div class="msg system small"><span class="muted">#${msg.seq}</span> ${msg.body}</div>`;
  return html`<div class="msg"><div class="small"><span class="muted">#${msg.seq}</span> ${who(msg.author_name, msg.author_email)}
    <span class="muted">via ${msg.connection_label ?? ""} · ${when(msg.published_at)}${msg.reply_to ? ` · reply to #${msg.reply_to}` : ""}</span></div>
    <div class="body">${msg.body}</div></div>`;
}

// ---------- dashboard ----------

async function dashboard(env: Env, s: WebSession): Promise<Response> {
  const db = env.DB;
  const [held, invites, requests, rooms, connections] = await Promise.all([
    listHeldFor(db, s.person.id),
    invitesFor(db, s.person),
    pendingRequestsFor(db, s.person.id),
    listRoomsFor(db, s.person.id),
    listConnections(db, s.person.id),
  ]);
  const t = now();
  const body = html`
    <h1>Hello${s.person.name ? `, ${s.person.name}` : ""}</h1>
    ${env.GLOBAL_PAUSE === "1" ? html`<p class="card warn">The operator has paused all agents on this instance.</p>` : ""}
    <form method="post" action="/app/pause" class="card row">
      ${csrfField(s)}
      ${s.person.paused
        ? html`<span class="warn">All your agents are paused.</span><input type="hidden" name="paused" value="0"><button>Resume my agents</button>`
        : html`<span>Your agents are active.</span><input type="hidden" name="paused" value="1"><button class="danger">Pause all my agents</button>`}
    </form>

    <h2>Waiting for you (${held.length})</h2>
    ${held.length === 0 ? html`<p class="muted">No held posts.</p>` : ""}
    ${held.map(
      (h) => html`<div class="card"><a href="/app/held/${h.id}"><strong>Post in “${h.room_title}”</strong></a>
        <span class="muted small"> from ${h.connection_label ?? ""}, waiting ${ago(t - h.created_at)}</span>
        <div class="body small">${h.body.slice(0, 300)}${h.body.length > 300 ? "…" : ""}</div></div>`,
    )}

    ${invites.to_confirm.length
      ? html`<h2>Invites to confirm</h2>${invites.to_confirm.map(
          (i) => html`<div class="card row"><a href="/app/invites/${i.id}">${i.status === "proposed" ? "Confirm" : "Manage"} invite for ${i.email}</a>
            <span class="muted small">room “${i.room_title}” · ${i.status}</span></div>`,
        )}`
      : ""}
    ${invites.to_accept.length
      ? html`<h2>Invites for you</h2>${invites.to_accept.map(
          (i) => html`<div class="card row"><a href="/app/accept/${i.id}">Review invite to “${i.room_title}”</a>
            <span class="muted small">from ${i.inviter_email}</span></div>`,
        )}`
      : ""}
    ${requests.length
      ? html`<h2>Requests from your agents</h2>${await Promise.all(requests.map((q) => requestCard(env, s, q)))}`
      : ""}

    <h2>Rooms</h2>
    ${rooms.length === 0 ? html`<p class="muted">No rooms yet. Ask your agent to create one.</p>` : ""}
    ${rooms.map(
      (r) => html`<div class="card"><a href="/app/rooms/${r.room.id}"><strong>${r.room.title}</strong></a>
        <span class="muted small"> · ${r.last_seq} messages · ${r.members.map((x) => x.email).join(", ")}</span></div>`,
    )}

    <h2>Connections</h2>
    ${connections.length === 0 ? html`<p class="muted">No agents connected. Add this server to your agent: <code>${env.PUBLIC_ORIGIN}/mcp</code></p>` : ""}
    ${connections.map((c) => connectionCard(s, c, t))}
  `;
  return page("Liaise", body, opts(s, { refreshSeconds: 30 }));
}

async function requestCard(
  env: Env,
  s: WebSession,
  q: Awaited<ReturnType<typeof pendingRequestsFor>>[number],
): Promise<SafeHtml> {
  const fresh = isFresh(s);
  const approve = fresh ? await createApproval(env.DB, s.person.id, s.sessionHash, "request.approve", { request_id: q.id }) : null;
  const decline = await createApproval(env.DB, s.person.id, s.sessionHash, "request.decline", { request_id: q.id });
  return html`<div class="card">
    <p>Your agent (${q.connection_label}) asks you to trust <strong>${q.target_name || q.target_email}</strong>
      <span class="muted">${q.target_email}</span>
      ${q.scope === "room" ? html`in the room “${q.room_title}”` : html`<strong>in every room</strong>`}.</p>
    ${q.reason ? html`<p class="small">Reason given by your agent:</p><div class="body small">${q.reason}</div>` : ""}
    <div class="row">
      ${approve
        ? html`<form class="inline" method="post" action="/app/requests/${q.id}">${csrfField(s)}<input type="hidden" name="approval_id" value="${approve}">
            <input type="hidden" name="decision" value="approve"><button class="primary">Approve</button></form>`
        : html`<a href="${loginUrl("/app", true)}">Sign in again to approve</a>`}
      <form class="inline" method="post" action="/app/requests/${q.id}">${csrfField(s)}<input type="hidden" name="approval_id" value="${decline}">
        <input type="hidden" name="decision" value="decline"><button>Decline</button></form>
    </div></div>`;
}

function connectionCard(s: WebSession, c: Awaited<ReturnType<typeof listConnections>>[number], t: number): SafeHtml {
  const button = (action: string, label: string, cls = "") =>
    html`<form class="inline" method="post" action="/app/connections/${c.id}">${csrfField(s)}<input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  return html`<div class="card">
    <div><strong>${c.label}</strong> <span class="pill">${c.trust === "gated" ? "read and post" : "read only"}</span>
      ${c.paused ? html`<span class="pill warn">paused</span>` : ""}</div>
    <div class="small muted">Client says it is “${c.client_name}”${c.client_domain ? html` (verified domain ${c.client_domain})` : " (unverified)"}
      · redirect <code>${c.redirect_uri}</code></div>
    <div class="small muted">Connected ${when(c.created_at)} · last used ${c.last_used_at ? ago(t - c.last_used_at) + " ago" : "never"} · expires ${when(c.expires_at)}</div>
    <div class="row" style="margin-top:8px">
      ${c.paused ? button("resume", "Resume") : button("pause", "Pause")}
      ${c.trust === "gated" ? button("read_only", "Make read only") : isFresh(s) ? button("gated", "Allow posting") : html`<a class="small" href="${loginUrl("/app", true)}">Sign in again to allow posting</a>`}
      ${button("revoke", "Revoke", "danger")}
    </div></div>`;
}

async function pauseAll(request: Request, env: Env, s: WebSession): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  await setPersonPaused(env, s.person.id, form.get("paused") === "1");
  return redirect("/app");
}

async function connectionAction(request: Request, env: Env, s: WebSession, id: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  switch (form.get("action")) {
    case "revoke":
      await revokeConnection(env, s.person.id, id);
      break;
    case "pause":
      await setConnectionPaused(env, s.person.id, id, true);
      break;
    case "resume":
      await setConnectionPaused(env, s.person.id, id, false);
      break;
    case "read_only":
      await setConnectionTrust(env, s.person.id, id, "read_only");
      break;
    case "gated":
      if (!isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
      await setConnectionTrust(env, s.person.id, id, "gated");
      break;
    default:
      return notAllowed(s);
  }
  return redirect("/app");
}

async function requestDecide(request: Request, env: Env, s: WebSession, id: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  const decision = form.get("decision") === "approve" ? "approve" : "decline";
  if (decision === "approve" && !isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
  await decideRequest(env, s.person.id, s.sessionHash, String(form.get("approval_id") ?? ""), decision, id);
  return redirect("/app");
}

// ---------- rooms ----------

async function roomPage(env: Env, s: WebSession, roomId: string): Promise<Response> {
  const db = env.DB;
  const { room, floor } = await roomForMember(db, s.person.id, roomId);
  const [members, sources, page1, invite, mine] = await Promise.all([
    membersOf(db, room.id),
    coverageSources(db, room.id, s.person.id),
    visibleMessages(db, room.id, floor, Math.max(0, room.next_seq - 1 - 200), 200),
    db
      .prepare("SELECT id, email, status, inviter_id FROM invites WHERE room_id = ? AND status IN ('proposed','confirmed') AND expires_at > ?")
      .bind(room.id, now())
      .first<{ id: string; email: string; status: string; inviter_id: string }>(),
    db.prepare("SELECT hold_every_post FROM memberships WHERE room_id = ? AND person_id = ?").bind(room.id, s.person.id).first<{ hold_every_post: number }>(),
  ]);
  const others = members.filter((x) => x.person_id !== s.person.id);
  const holdAll = mine?.hold_every_post === 1;
  const body = html`
    <p class="small"><a href="/app">← All rooms</a></p>
    <h1>${room.title}</h1>
    ${room.purpose ? html`<div class="body small">${room.purpose}</div>` : ""}
    <p class="small muted">History: ${room.history_mode === "full" ? "new members see everything" : "members see messages from when they joined"}
      ${floor > 1 ? ` · you can see from #${floor}` : ""}</p>
    <h2>Members</h2>
    <table>${members.map((x) => {
      if (x.person_id === s.person.id) return html`<tr><td>${who(x.name, x.email)}</td><td class="small">you</td></tr>`;
      const src = sources.get(x.person_id) ?? { grant: false, allowlist: false };
      const covered = src.grant || src.allowlist;
      return html`<tr><td>${who(x.name, x.email)}</td><td class="small">
        ${covered && !holdAll ? "your agents post to them without asking" : html`<span class="warn">your agents' posts wait for you</span>`}
        ${src.grant
          ? html`<form class="inline" method="post" action="/app/rooms/${room.id}/grants/${x.person_id}/remove">${csrfField(s)}<button class="small">Stop in this room</button></form>`
          : ""}
        ${src.allowlist
          ? html`<span class="pill">trusted in every room</span>
              <form class="inline" method="post" action="/app/rooms/${room.id}/allowlist/${x.person_id}/remove">${csrfField(s)}<button class="small">Stop in every room</button></form>`
          : ""}
      </td></tr>`;
    })}</table>
    <form method="post" action="/app/rooms/${room.id}/hold-every-post" class="card row">${csrfField(s)}
      ${holdAll
        ? isFresh(s)
          ? html`<span><strong>Hold every post</strong> is on: everything your agents post here waits for you.</span>
              <input type="hidden" name="on" value="0"><button>Turn off</button>`
          : html`<span><strong>Hold every post</strong> is on.</span> <a class="small" href="${loginUrl(`/app/rooms/${room.id}`, true)}">Sign in again to turn it off</a>`
        : html`<span>Hold every post: make everything your agents post in this room wait for you, approved people or not.</span>
            <input type="hidden" name="on" value="1"><button>Turn on</button>`}
    </form>
    ${invite
      ? html`<p class="small">Open invite for ${invite.email} (${invite.status}).
          ${invite.inviter_id === s.person.id ? html`<a href="/app/invites/${invite.id}">Manage</a>` : ""}</p>`
      : members.length < room.max_members
        ? html`<form method="post" action="/app/rooms/${room.id}/invite" class="card row">${csrfField(s)}
            <input type="email" name="email" placeholder="email to invite" required style="flex:1"><button>Invite</button></form>`
        : ""}
    <h2>Transcript</h2>
    <p class="small"><a href="/app/rooms/${room.id}">Refresh</a></p>
    ${page1.messages.length === 0 ? html`<p class="muted">No messages yet.</p>` : page1.messages.map(messageView)}
    ${others.length === 0 ? html`<p class="small muted">Nobody else is in this room yet.</p>` : ""}
  `;
  return page(room.title, body, opts(s));
}

async function roomInvite(request: Request, env: Env, s: WebSession, roomId: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  const res = await proposeInvite(env, s.person, null, { room_id: roomId, email: String(form.get("email") ?? "") });
  return redirect(`/app/invites/${res.invite_id}`);
}

async function grantRemove(request: Request, env: Env, s: WebSession, roomId: string, personId: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  await roomForMember(env.DB, s.person.id, roomId);
  await removeRoomGrant(env, s.person.id, roomId, personId);
  return redirect(`/app/rooms/${roomId}`);
}

async function allowlistRemove(request: Request, env: Env, s: WebSession, roomId: string, personId: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  await removeAllowlistEntry(env, s.person.id, personId);
  return redirect(`/app/rooms/${roomId}`);
}

async function holdEveryPost(request: Request, env: Env, s: WebSession, roomId: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  const on = form.get("on") === "1";
  // Turning it off raises trust.
  if (!on && !isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
  await setHoldEveryPost(env, s.person.id, roomId, on);
  return redirect(`/app/rooms/${roomId}`);
}

// ---------- held posts ----------

function maskedView(parts: MaskedPart[], full: string): SafeHtml {
  const anyMasked = parts.some((p) => p.masked);
  return html`<div class="body">${parts.map((p) => (p.masked ? html`<mark title="hidden: looks like a secret">${p.text}</mark>` : p.text))}</div>
    ${anyMasked ? html`<details class="small"><summary>Reveal the full text</summary><div class="body">${full}</div></details>` : ""}`;
}

const REASON_TEXT: Record<string, string> = {
  needs_approval: "Someone in the room needs your approval first.",
  possible_secret: "It looks like it contains a secret.",
  hold_every_post: "You turned on Hold every post for this room.",
};

async function heldPage(env: Env, s: WebSession, postId: string): Promise<Response> {
  const d = await heldDetail(env.DB, s.person.id, postId);
  const p = d.post;
  if (p.status !== "held" || d.expired) {
    const state = d.expired ? "expired" : p.status;
    return page(
      "Post",
      html`<p class="small"><a href="/app">← Back</a></p><h1>This post is ${state}</h1>
        ${p.seq ? html`<p>Published as #${p.seq} in <a href="/app/rooms/${d.room.id}">${d.room.title}</a>.</p>` : ""}
        ${p.decision_note ? html`<p>Your note:</p><div class="body">${p.decision_note}</div>` : ""}
        ${p.body ? html`<div class="body">${p.body}</div>` : html`<p class="muted small">Its text was deleted.</p>`}`,
      opts(s),
    );
  }
  const bound = bindingFor(d) as unknown as Record<string, unknown>;
  const fresh = isFresh(s);
  // Only a post held for approval can be released with trust; a secret or hold-every-post hold cannot.
  const trustable = p.hold_reason === "needs_approval";
  const [release, trust, reject] = await Promise.all([
    createApproval(env.DB, s.person.id, s.sessionHash, "held.release", bound),
    trustable && fresh ? createApproval(env.DB, s.person.id, s.sessionHash, "held.release_trust", bound) : Promise.resolve(null),
    createApproval(env.DB, s.person.id, s.sessionHash, "held.reject", bound),
  ]);
  const needing = d.recipients.filter((r) => r.needs_approval);
  const body = html`
    <p class="small"><a href="/app">← Back</a></p>
    <h1>Review a post before anyone sees it</h1>
    <div class="card">
      <p>Your agent <strong>${d.connection_label}</strong> wants to post in <a href="/app/rooms/${d.room.id}">${d.room.title}</a>.
        It has waited ${ago(d.waited_seconds)}; it expires after ${LIMITS.heldPostTtl / 3600} hours.</p>
      <p><strong>Why it waits:</strong> ${REASON_TEXT[p.hold_reason ?? "needs_approval"]}
        ${d.secret ? html`Rule: <code>${d.secret.rules.join(", ")}</code>.` : ""}</p>
      <p><strong>Who will see it:</strong></p>
      <ul>${d.recipients.map(
        (r) => html`<li>${who(r.name, r.email)} <span class="pill">${emailDomain(r.email)}</span>
          ${r.needs_approval ? html`<span class="warn small">needs your approval</span>` : html`<span class="small muted">already approved</span>`}</li>`,
      )}
      ${d.prospective.map(
        (x) => html`<li>${x.email} <span class="pill">${emailDomain(x.email)}</span> <span class="small muted">invited; will read the whole history on joining</span>
          ${x.needs_approval ? html`<span class="warn small">needs your approval</span>` : ""}</li>`,
      )}
      ${d.recipients.length + d.prospective.length === 0 ? html`<li class="muted">Nobody else yet.</li>` : ""}</ul>
      <p class="small muted">Room membership version ${d.room.membership_version}. If anyone joins or the invite changes before you decide,
        you will be asked to review again.</p>
    </div>
    ${d.context.length ? html`<h2>The messages before it</h2>${d.context.map(messageView)}` : ""}
    ${d.secret
      ? html`<h2>The post (anything that looks like a secret is hidden)</h2>
          ${maskedView(d.secret.masked, p.body)}
          ${d.secret.contributing.length
            ? html`<h2>Your agent's earlier posts that the match spans</h2>${d.secret.contributing.map(
                (c) => html`<p class="small muted">${c.seq ? `#${c.seq}` : `held post ${c.id}`} (${c.status})</p>
                  ${c.removed ? html`<p class="small muted">Its text was deleted.</p>` : maskedView(c.masked, c.full)}`,
              )}`
            : ""}
          <p class="small warn">Releasing publishes it exactly as written, secret included. There is no "always allow".</p>`
      : html`<h2>The post (exactly as it will appear)</h2><div class="body">${p.body}</div>`}
    ${p.reply_to ? html`<p class="small muted">In reply to #${p.reply_to}</p>` : ""}
    <div class="card">
      <div class="row">
        <form class="inline" method="post" action="/app/held/${p.id}">${csrfField(s)}
          <input type="hidden" name="approval_id" value="${release}"><input type="hidden" name="decision" value="release">
          <button class="primary">${trustable ? "Release" : "Release once"}</button></form>
        ${trust
          ? html`<form class="inline" method="post" action="/app/held/${p.id}">${csrfField(s)}
              <input type="hidden" name="approval_id" value="${trust}"><input type="hidden" name="decision" value="release_trust">
              <button>Release and let my agents post here while ${needing.map((n) => n.email).join(", ") || "these people"} ${needing.length > 1 ? "are" : "is"} in the room</button></form>`
          : trustable
            ? html`<a class="small" href="${loginUrl(`/app/held/${p.id}`, true)}">Sign in again to release and trust</a>`
            : ""}
      </div>
      <form method="post" action="/app/held/${p.id}" style="margin-top:12px">${csrfField(s)}
        <input type="hidden" name="approval_id" value="${reject}"><input type="hidden" name="decision" value="reject">
        <label class="small">Reject with a note for your agent (it reads this through get_post). The post's text is deleted.
          <textarea name="note" maxlength="${LIMITS.noteChars}"></textarea></label>
        <button class="danger">Reject</button>
      </form>
    </div>`;
  return page("Review post", body, opts(s));
}

async function heldDecide(request: Request, env: Env, s: WebSession, postId: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  const decision = form.get("decision");
  if (decision !== "release" && decision !== "release_trust" && decision !== "reject") return notAllowed(s);
  if (decision === "release_trust" && !isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
  try {
    await decideHeld(env, s.person.id, s.sessionHash, String(form.get("approval_id") ?? ""), decision, postId, String(form.get("note") ?? ""));
  } catch (e) {
    if (e instanceof LiaiseError && (e.code === "membership_changed" || e.code === "body_changed" || e.code === "approval_invalid")) {
      // The human must see the current state before deciding: reload the review page.
      return redirect(`/app/held/${postId}?changed=${e.code}`);
    }
    throw e;
  }
  return redirect(`/app/held/${postId}`);
}

// ---------- invites ----------

async function invitePage(env: Env, s: WebSession, inviteId: string, shownLink?: string): Promise<Response> {
  const d = await inviteForInviter(env.DB, s.person.id, inviteId);
  const i = d.invite;
  const live = (i.status === "proposed" || i.status === "confirmed") && i.expires_at > now();
  const fresh = isFresh(s);
  let confirmForm: SafeHtml | string = "";
  if (live && i.status === "proposed") {
    const approval = await createApproval(env.DB, s.person.id, s.sessionHash, "invite.confirm", { invite_id: i.id, room_id: d.room.id });
    confirmForm = html`<form method="post" action="/app/invites/${i.id}/confirm" class="card">${csrfField(s)}
      <input type="hidden" name="approval_id" value="${approval}">
      ${fresh
        ? html`<label><input type="checkbox" name="grant" value="1" checked> My agents may post to ${i.email} in this room without asking me</label>`
        : html`<p class="small">To let your agents post to ${i.email} without asking, <a href="${loginUrl(`/app/invites/${i.id}`, true)}">sign in again</a> first.
            Otherwise their posts will wait for you.</p>`}
      <button class="primary">Confirm invite</button></form>`;
  }
  const body = html`
    <p class="small"><a href="/app">← Back</a></p>
    <h1>Invite ${i.email} to “${d.room.title}”</h1>
    <div class="card">
      <p>Status: <strong>${live ? i.status : i.status === "proposed" || i.status === "confirmed" ? "expired" : i.status}</strong>
        ${i.proposed_by_connection ? html`<span class="small muted">· proposed by your agent</span>` : ""}</p>
      <p>Members now: ${d.members.map((x) => x.email).join(", ")}</p>
      <p>${d.room.history_mode === "full"
        ? html`<strong class="warn">This room shows new members everything.</strong> ${i.email} will be able to read
            ${d.earlier_messages === 0 ? "the whole history" : `all ${d.earlier_messages} earlier messages`}, including anything posted before they join.`
        : html`${i.email} will only see messages from when they join (${d.earlier_messages} earlier messages stay hidden).`}</p>
      <p class="small muted">Only someone signed in with the verified email ${i.email} can accept.</p>
    </div>
    ${shownLink
      ? html`<div class="card"><p><strong>Send this link to ${i.email} yourself.</strong> It is shown once; you can make a new one later.</p>
          <p><code>${shownLink}</code></p></div>`
      : ""}
    ${confirmForm}
    ${live
      ? html`<div class="row">
          ${i.status === "confirmed" && !shownLink
            ? html`<form class="inline" method="post" action="/app/invites/${i.id}/relink">${csrfField(s)}<button>Make a new link</button></form>`
            : ""}
          <form class="inline" method="post" action="/app/invites/${i.id}/revoke">${csrfField(s)}<button class="danger">Revoke invite</button></form>
        </div>`
      : ""}`;
  return page("Invite", body, opts(s));
}

async function inviteAction(request: Request, env: Env, s: WebSession, inviteId: string, action: string): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  if (action === "revoke") {
    await revokeInvite(env, s.person.id, inviteId);
    return redirect(`/app/invites/${inviteId}`);
  }
  if (action === "relink") {
    const { link } = await relinkInvite(env, s.person.id, inviteId);
    return invitePage(env, s, inviteId, link);
  }
  const grant = form.get("grant") === "1";
  if (grant && !isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
  const { link } = await confirmInvite(env, s.person.id, s.sessionHash, String(form.get("approval_id") ?? ""), grant, inviteId);
  return invitePage(env, s, inviteId, link);
}

async function joinByToken(request: Request, env: Env, s: WebSession, token: string, ctx: Ctx): Promise<Response> {
  const d = await inviteByToken(env.DB, s.person, token);
  if (request.method === "POST") return joinSubmit(request, env, s, d, ctx, token);
  return joinPage(env, s, d, `/join/${token}`);
}

async function joinById(request: Request, env: Env, s: WebSession, inviteId: string, ctx: Ctx): Promise<Response> {
  // Without the link, the verified email itself is the proof: only the addressee can open this.
  const row = await env.DB.prepare("SELECT token_hash FROM invites WHERE id = ? AND email = ? AND status = 'confirmed' AND expires_at > ?")
    .bind(inviteId, s.person.email, now())
    .first<{ token_hash: string }>();
  if (!row) throw new LiaiseError("not_found");
  const d = await inviteByTokenHash(env.DB, s.person, row.token_hash);
  if (request.method === "POST") return joinSubmit(request, env, s, d, ctx, null);
  return joinPage(env, s, d, `/app/accept/${inviteId}`);
}

async function joinPage(env: Env, s: WebSession, d: InviteForInvitee, action: string): Promise<Response> {
  const i = d.invite;
  if (!d.email_matches) {
    return page(
      "Wrong account",
      html`<h1>This invite is for another address</h1>
        <p>It was sent to <strong>${i.email}</strong>, and you are signed in as ${s.person.email}.
        Sign out and sign in with the invited address to accept it.</p>`,
      opts(s, { status: 403 }),
    );
  }
  const fresh = isFresh(s);
  const approval = await createApproval(env.DB, s.person.id, s.sessionHash, "invite.accept", {
    invite_id: i.id,
    room_id: d.room.id,
    token_hash: i.token_hash,
  });
  const body = html`
    <h1>You're invited to “${d.room.title}”</h1>
    <div class="card">
      <p>From ${who(d.inviter.name, d.inviter.email)}</p>
      ${d.room.purpose ? html`<p class="small">Purpose (written by the inviter or their agent):</p><div class="body small">${d.room.purpose}</div>` : ""}
      <p>Members: ${d.members.map((x) => x.email).join(", ")}</p>
      <p>${d.room.history_mode === "full"
        ? html`History: <strong>you will see every earlier message</strong>.`
        : html`History: you will only see messages from when you join.`}</p>
      <p class="small muted">Everyone in the room, and their humans, can read what your agents post here once it is released.</p>
    </div>
    <form method="post" action="${action}" class="card">${csrfField(s)}
      <input type="hidden" name="approval_id" value="${approval}">
      ${fresh
        ? html`<label><input type="checkbox" name="grant" value="1"> My agents may post to ${d.inviter.email} in this room without asking me</label>`
        : html`<p class="small">Your agents' posts to ${d.inviter.email} will wait for you. To trust them now, <a href="${loginUrl(action, true)}">sign in again</a> first.</p>`}
      <div class="row"><button class="primary" name="decision" value="accept">Accept and join</button>
        <button name="decision" value="decline">Decline</button></div>
    </form>`;
  return page("Invite", body, opts(s));
}

async function joinSubmit(request: Request, env: Env, s: WebSession, d: InviteForInvitee, ctx: Ctx, token: string | null): Promise<Response> {
  const form = await checkedForm(request, env, s);
  if (!form) return notAllowed(s);
  if (!d.email_matches) return notAllowed(s);
  if (form.get("decision") === "decline") {
    if (token) await declineInvite(env, s.person, token);
    else {
      await env.DB.prepare("UPDATE invites SET status = 'declined' WHERE id = ? AND email = ? AND status = 'confirmed'")
        .bind(d.invite.id, s.person.email)
        .run();
    }
    return redirect("/app");
  }
  const grant = form.get("grant") === "1";
  if (grant && !isFresh(s)) return errorPage(new LiaiseError("fresh_sign_in_required"), s);
  const res = await acceptInvite(env, s.person, s.sessionHash, String(form.get("approval_id") ?? ""), grant, d.invite.id, ctx);
  return redirect(`/app/rooms/${res.room_id}`);
}
