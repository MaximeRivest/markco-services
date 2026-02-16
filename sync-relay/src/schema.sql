-- Sync Relay: persistent Yjs document storage
-- Documents survive container restarts, enabling cross-device sync.

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  project TEXT NOT NULL,
  doc_path TEXT NOT NULL,
  yjs_state BYTEA,
  content_text TEXT,
  content_hash TEXT,
  byte_size INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, project, doc_path)
);

CREATE INDEX IF NOT EXISTS idx_documents_user_project
  ON documents(user_id, project);
CREATE INDEX IF NOT EXISTS idx_documents_updated
  ON documents(updated_at);
