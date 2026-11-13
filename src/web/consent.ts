import type { AuthRequest, ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { createApproval, loadApproval } from "../core/approvals";
import { LiaiseError } from "../core/errors";
import { createConnection } from "../core/people";
import { refuseSecretMetadata } from "../core/rooms";
import { now, safeLabel } from "../core/util";
import { loginUrl } from "./auth";
import { html, page, redirect } from "./html";
import { checkedForm, getSession, isFresh } from "./session";

interface ConsentParams {
  authRequest: AuthRequest;
  clientName: string;
  clientDomain: string | null;
  redirectUri: string;
  redirectIsLoopback: boolean;
}

function redirectSource(uri: string): string {
  const u = new URL(uri);
  return u.protocol === "http:" || u.protocol === "https:" ? u.origin : u.protocol;
}

/** GET /authorize: the consent screen for a new MCP client. */
export async function authorizePage(request: Request, env: Env, url: URL): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER!;
  // Sign-in comes first, so an anonymous request cannot make the Worker fetch a client's metadata.
  const session = await getSession(request, env);
  const here = url.pathname + url.search;
  // Approving a client needs a fresh sign-in, so ask for one straight away.
  if (!session) return redirect(loginUrl(here, true));
  let authRequest: AuthRequest;
  let described: ConsentDescription;
  try {
    authRequest = await helpers.parseAuthRequest(request);
    described = await helpers.describeConsent(authRequest);
  } catch (e) {
    console.warn("authorize request refused", String((e as Error)?.message ?? e).slice(0, 300));
    return page(
      "Invalid request",
      html`<h1>This sign-in request is not valid</h1><p>Start the connection from your agent again. If it keeps failing, the app may not
        support this server's sign-in.</p>`,
      { status: 400, signedInEmail: session.person.email, csrf: session.csrf },
    );
  }
  if (!isFresh(session)) {
    return page(
      "Sign in again",
      html`<h1>Sign in again to connect an agent</h1>
        <p>Approving a new agent needs a recent sign-in.</p>
        <p><a href="${loginUrl(here, true)}">Sign in again</a></p>`,
      { signedInEmail: session.person.email, csrf: session.csrf },
    );
  }
  const params: ConsentParams = {
    authRequest,
    clientName: described.clientName,
    clientDomain: described.clientDomain ?? null,
    redirectUri: described.redirectUri,
    redirectIsLoopback: described.redirectIsLoopback,
  };
  const approvalId = await createApproval(env.DB, session.person.id, session.sessionHash, "consent", params as unknown as Record<string, unknown>);
  const suggested = safeLabel(described.clientName) || "My agent";
  return page(
    "Connect an agent",
    html`<h1>Connect an agent to Liaise</h1>
      <div class="card">
        <p>An app calling itself <strong>${described.clientName}</strong>
          ${described.clientDomain
            ? html`(verified domain <strong>${described.clientDomain}</strong>)`
            : html`<span class="pill warn">name not verified</span>`}
          wants to act for <strong>${session.person.email}</strong> in Liaise.</p>
        <p class="small">It will be sent back to <code>${described.redirectUri}</code>.</p>
        ${described.redirectIsLoopback
          ? html`<p class="small warn">This address is on your own computer. Any program running there could be the one asking.
              Only continue if you just started this sign-in from your agent.</p>`
          : ""}
        <p class="small muted">It will be able to read rooms you are in, create rooms, propose invites, and post. Posts to people you
          haven't approved wait for you here. It can never release posts, accept invites or change who you trust.</p>
      </div>
      <form method="post" action="/consent" class="card">
        <input type="hidden" name="csrf" value="${session.csrf}">
        <input type="hidden" name="approval_id" value="${approvalId}">
        <label>Label for this connection (others in your rooms see it)
          <input type="text" name="label" value="${suggested}" maxlength="40" required></label>
        <label>Access
          <select name="trust">
            <option value="gated" selected>Read and post (posts to people you haven't approved wait for you)</option>
            <option value="read_only">Read only</option>
          </select></label>
        <div class="row">
          <button class="primary" name="decision" value="approve">Connect</button>
          <button name="decision" value="deny">Cancel</button>
        </div>
      </form>`,
    { formAction: [redirectSource(described.redirectUri)], signedInEmail: session.person.email, csrf: session.csrf },
  );
}

/** POST /consent */
export async function consentSubmit(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return page("Signed out", html`<h1>You are signed out</h1>`, { status: 401 });
  const form = await checkedForm(request, env, session);
  if (!form) return page("Not allowed", html`<h1>That request was not allowed</h1>`, { status: 403 });
  const approvalId = String(form.get("approval_id") ?? "");
  let params: ConsentParams;
  try {
    params = await loadApproval<ConsentParams>(env.DB, approvalId, session.person.id, session.sessionHash, "consent");
  } catch {
    return page("Expired", html`<h1>This form expired</h1><p>Start the sign-in from your agent again.</p>`, { status: 400 });
  }
  // Single use, whatever the decision.
  const used = await env.DB.prepare("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now(), approvalId).run();
  if (used.meta.changes !== 1) return page("Expired", html`<h1>This form was already used</h1>`, { status: 400 });

  const ar = params.authRequest;
  if (form.get("decision") !== "approve") {
    const u = new URL(ar.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (ar.state) u.searchParams.set("state", ar.state);
    if (ar.issuer) u.searchParams.set("iss", ar.issuer);
    return redirect(u.toString());
  }
  if (!isFresh(session)) return page("Sign in again", html`<h1>Sign in again to connect an agent</h1>`, { status: 403 });

  const trust = form.get("trust") === "read_only" ? "read_only" : "gated";
  // Scan exactly the label that will be stored and shown to others.
  const label = safeLabel(String(form.get("label") ?? "")) || safeLabel(params.clientName) || "Agent";
  try {
    refuseSecretMetadata("label", label);
  } catch (e) {
    if (e instanceof LiaiseError) {
      return page("Choose another label", html`<h1>Choose another label</h1><p>${e.message} Start the connection from your agent again.</p>`, {
        status: 400,
        signedInEmail: session.person.email,
        csrf: session.csrf,
      });
    }
    throw e;
  }
  const connection = await createConnection(env.DB, session.person.id, {
    clientId: ar.clientId,
    clientName: params.clientName,
    clientDomain: params.clientDomain,
    redirectUri: params.redirectUri,
    label,
    trust,
  });
  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER!.completeAuthorization({
      request: ar,
      userId: session.person.id,
      metadata: { connectionId: connection.id, label: connection.label },
      scope: ar.scope,
      props: { personId: session.person.id, connectionId: connection.id },
    }));
  } catch (e) {
    // No grant was made: do not leave a connection behind that looks usable.
    await env.DB.prepare("UPDATE connections SET revoked_at = ?, revoked_reason = 'authorization failed' WHERE id = ?").bind(now(), connection.id).run();
    console.error("completeAuthorization failed", String((e as Error)?.message ?? e).slice(0, 300));
    return page("Could not connect", html`<h1>Could not connect the agent</h1><p>Start the connection from your agent again.</p>`, {
      status: 500,
      signedInEmail: session.person.email,
      csrf: session.csrf,
    });
  }
  // completeAuthorization replaces earlier grants for this person and client; mirror that here.
  await env.DB.prepare(
    `UPDATE connections SET revoked_at = ?, revoked_reason = 'replaced by a new sign-in'
      WHERE person_id = ? AND client_id = ? AND id != ? AND revoked_at IS NULL
        AND (client_id NOT LIKE 'https://%' OR redirect_uri = ?)`,
  )
    .bind(now(), session.person.id, ar.clientId, connection.id, params.redirectUri)
    .run();
  return redirect(redirectTo);
}
