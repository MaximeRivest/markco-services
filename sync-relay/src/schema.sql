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

-- ─── Machine Registry ───────────────────────────────────────────────────────
-- Tracks connected desktop machines (Electron apps / machine-agents).

CREATE TABLE IF NOT EXISTS machines (
  user_id UUID NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  machine_name TEXT,
  hostname TEXT,
  capabilities TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  connected_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, machine_id)
);

-- ─── File Catalog ───────────────────────────────────────────────────────────
-- Lightweight manifest of what files exist on which machines.
-- No file content or Yjs state — just names, hashes, and sizes.

CREATE TABLE IF NOT EXISTS catalog (
  user_id UUID NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  project TEXT NOT NULL,
  doc_path TEXT NOT NULL,
  content_hash TEXT,
  byte_size INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, machine_id, project, doc_path)
);

CREATE INDEX IF NOT EXISTS idx_catalog_user
  ON catalog(user_id);
CREATE INDEX IF NOT EXISTS idx_catalog_user_project
  ON catalog(user_id, project);
