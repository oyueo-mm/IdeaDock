-- IdeaDock sign-in store (Cloudflare D1). Holds no idea data: ideas, folders
-- and images stay in each user's Google Drive and on their devices.

-- One row per Google account (`sub`). Tokens are AES-256-GCM sealed with the
-- TOKEN_ENCRYPTION_KEY secret and bound to the sub, never stored in plain text.
CREATE TABLE IF NOT EXISTS accounts (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  access_issued_at INTEGER,
  access_expires_at INTEGER,
  -- Lease so concurrent tabs/devices refresh once instead of all at once.
  refresh_lock_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only the SHA-256 of the session cookie is stored; a leaked table cannot be
-- replayed as a cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL REFERENCES accounts (sub) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_sub ON sessions (sub);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at);
