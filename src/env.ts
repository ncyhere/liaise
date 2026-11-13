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
  /** "1" pauses every agent on this instance (operator switch). */
  GLOBAL_PAUSE?: string;
  /** Optional email provider for notices (Resend-compatible HTTP API). */
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
  /** Injected by workers-oauth-provider into the default handler's env. */
  OAUTH_PROVIDER?: OAuthHelpers;
}
