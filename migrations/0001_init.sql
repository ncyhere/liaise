-- Liaise v0.1 schema. All application state lives here; OAuth grants and tokens live in KV
-- (workers-oauth-provider). Times are Unix seconds.

-- A human, keyed on the sign-in provider's stable subject id, never on email.
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,             -- 'google' or 'dev' (local only)
  subject TEXT NOT NULL,              -- Google `sub`
  email TEXT NOT NULL,                -- verified, lower-cased
  name TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0,  -- "pause all my agents"
  created_at INTEGER NOT NULL,
  UNIQUE (provider, subject)
);
CREATE INDEX people_email ON people (email);

-- Browser sessions. Only a hash of the cookie value is stored.
CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  csrf TEXT NOT NULL,
  auth_time INTEGER NOT NULL,         -- last completed sign-in, for "fresh sign-in" checks
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_person ON web_sessions (person_id);

-- In-flight sign-ins (state, nonce, PKCE verifier), bound to the browser by a cookie.
CREATE TABLE login_attempts (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Server-stored approvals: one per sensitive web action, bound to the person, their session,
-- the action and its exact parameters, single use and short-lived.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL,               -- canonical JSON
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- One MCP client a person approved. Mirrors one OAuth grant; checked on every MCP request.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,          -- as the client claims it: unverified
  client_domain TEXT,                 -- verified domain for Client ID Metadata Document clients
  redirect_uri TEXT NOT NULL,
  label TEXT NOT NULL,                -- chosen by the person
  trust TEXT NOT NULL CHECK (trust IN ('read_only', 'gated')),
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,        -- hard 90-day cap, however often it refreshes
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT
);
CREATE INDEX connections_person ON connections (person_id);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  history_mode TEXT NOT NULL CHECK (history_mode IN ('from_join', 'full')),
  max_members INTEGER NOT NULL DEFAULT 2,       -- v0.1: the creator and one invitee
  creator_id TEXT NOT NULL REFERENCES people (id),
  membership_version INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- A person's time in a room. visibility_floor is the first message number they may see.
CREATE TABLE memberships (
  room_id TEXT NOT NULL REFERENCES rooms (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  visibility_floor INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (room_id, person_id)
);
CREATE INDEX memberships_person ON memberships (person_id);

-- Posts. A post gets its message number (seq) only when it is published.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'system')),
  author_id TEXT REFERENCES people (id),          -- NULL for system lines
  connection_id TEXT REFERENCES connections (id),
  connection_label TEXT,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  reply_to INTEGER,
  status TEXT NOT NULL CHECK (status IN ('held', 'published', 'rejected', 'cancelled', 'expired')),
  seq INTEGER,
  membership_version INTEGER NOT NULL,            -- the room's version when the post was written
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  decided_at INTEGER,
  decision_note TEXT,                             -- the human's note on a rejection
  UNIQUE (room_id, seq),
  CHECK ((status = 'published') = (seq IS NOT NULL))
);
-- One held post per person per room, enforced by the database as well as the code.
CREATE UNIQUE INDEX posts_one_held ON posts (room_id, author_id) WHERE status = 'held';
CREATE INDEX posts_author_status ON posts (author_id, status);
CREATE INDEX posts_room_status ON posts (room_id, status);

-- send_message idempotency, keyed by connection, room and key.
CREATE TABLE idempotency (
  connection_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, room_id, key)
);

-- Room grants: "my agents may post in this room without asking while these people are in it".
-- One row per covered person, so a grant never stretches to cover someone who joins later.
CREATE TABLE room_grants (
  room_id TEXT NOT NULL REFERENCES rooms (id),
  granter_id TEXT NOT NULL REFERENCES people (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  source TEXT NOT NULL CHECK (source IN ('invite', 'accept', 'release_and_trust', 'request')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, granter_id, person_id)
);

-- People someone trusts in every room. Domain entries come in v0.2.
CREATE TABLE allowlist (
  owner_id TEXT NOT NULL REFERENCES people (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, person_id)
);

-- Agents' requests for a grant or allowlist entry. Only the human decides, on the web.
CREATE TABLE allowlist_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES people (id),
  connection_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms (id),
  target_person_id TEXT NOT NULL REFERENCES people (id),
  scope TEXT NOT NULL CHECK (scope IN ('room', 'everywhere')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX allowlist_requests_one_pending
  ON allowlist_requests (owner_id, room_id, target_person_id, scope) WHERE status = 'pending';

-- Invites: proposed (by an agent or the human), confirmed by the human (a link exists),
-- then accepted by a signed-in person whose verified email matches.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id),
  inviter_id TEXT NOT NULL REFERENCES people (id),
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'accepted', 'revoked', 'expired', 'declined')),
  token_hash TEXT UNIQUE,
  inviter_grant INTEGER NOT NULL DEFAULT 0,
  proposed_by_connection TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT
);
CREATE UNIQUE INDEX invites_one_open_per_room ON invites (room_id) WHERE status IN ('proposed', 'confirmed');
CREATE INDEX invites_email ON invites (email, status);

-- Email notices: room and count only, never message content.
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  room_id TEXT,
  count INTEGER,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT
);

CREATE TABLE rate_counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  person_id TEXT,
  connection_id TEXT,
  action TEXT NOT NULL,
  room_id TEXT,
  target TEXT,
  detail TEXT
);
CREATE INDEX audit_person ON audit (person_id, at);

-- Assertions inside a D1 batch. `INSERT INTO _assert (ok, code) SELECT <condition>, '<code>'`
-- aborts the whole batch (a transaction) with "liaise_assert:<code>" when the condition is false,
-- and inserts nothing when it is true. This is how every decision checks its preconditions in
-- the same transaction that writes the result.
CREATE TABLE _assert (ok INTEGER, code TEXT NOT NULL);
CREATE TRIGGER _assert_pass BEFORE INSERT ON _assert WHEN NEW.ok = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER _assert_fail BEFORE INSERT ON _assert WHEN NEW.ok IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'liaise_assert:' || NEW.code);
END;
