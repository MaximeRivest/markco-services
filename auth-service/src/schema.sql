CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  github_id TEXT UNIQUE,
  google_id TEXT UNIQUE,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_path TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

-- ─── Shares ─────────────────────────────────────────────────────────────
-- A share gives one or more people access to a notebook (or project)
-- owned by another user. The owner's Electron app is the source of truth.

CREATE TABLE IF NOT EXISTS shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who owns this share (the Electron user)
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- What is shared
  project TEXT NOT NULL,
  doc_path TEXT,                -- NULL = entire project shared

  -- Access control
  token TEXT UNIQUE NOT NULL,   -- URL-safe random token (32 bytes, base64url)
  role TEXT NOT NULL DEFAULT 'editor',  -- 'viewer' | 'editor'
  require_auth BOOLEAN DEFAULT TRUE,    -- FALSE = anyone with URL can access

  -- State
  active BOOLEAN DEFAULT TRUE,  -- Owner can pause/resume

  -- Optional
  label TEXT,                   -- human-readable name for the share
  invited_email TEXT,           -- if shared with a specific person
  expires_at TIMESTAMPTZ,
  max_uses INTEGER,             -- NULL = unlimited
  use_count INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

-- ─── Share Members ──────────────────────────────────────────────────────
-- Tracks which users have joined a share.

CREATE TABLE IF NOT EXISTS share_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(share_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_share_members_user ON share_members(user_id);
CREATE INDEX IF NOT EXISTS idx_share_members_share ON share_members(share_id);
