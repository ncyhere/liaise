import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** The one origin this instance answers on, e.g. "https://liaise.example.com". */
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "unsafe-local-only" enables the local dev sign-in. Refused unless PUBLIC_ORIGIN is loopback. */
  DEV_LOGIN?: string;
  /** Server secret (32+ characters) for keyed hashes of message bodies and matched secrets. */
  HASH_KEY: string;
  /**
   * Optional. Comma-separated emails and @domains allowed to sign up. Unset means anyone with a
   * verified Google account. Existing people and people holding a confirmed invite can always sign in.
   */
  SIGNUP_ALLOWLIST?: string;
  /** "1" pauses every agent on this instance (operator switch). */
  GLOBAL_PAUSE?: string;
  /** Optional email provider for notices (Resend-compatible HTTP API). */
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
  /** Injected by workers-oauth-provider into the default handler's env. */
  OAUTH_PROVIDER?: OAuthHelpers;
}
