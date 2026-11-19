-- Refresh and access tokens are AES-GCM-encrypted before insertion.
-- No user ideas, images or Google Drive content are stored in D1.
CREATE TABLE IF NOT EXISTS auth_sessions (
  sid_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  refresh_ciphertext TEXT NOT NULL,
  access_ciphertext TEXT NOT NULL,
  access_expires INTEGER NOT NULL,
  session_expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(session_expires);
