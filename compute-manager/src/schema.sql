CREATE TABLE IF NOT EXISTS runtimes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  container_name TEXT NOT NULL,
  ec2_instance_id TEXT,
  instance_type TEXT NOT NULL DEFAULT 'local',
  host TEXT NOT NULL DEFAULT 'localhost',
  port INTEGER,
  state TEXT DEFAULT 'running',
  memory_limit BIGINT DEFAULT 268435456,
  memory_used BIGINT DEFAULT 0,
  cpu_limit REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  runtime_id UUID REFERENCES runtimes(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id UUID REFERENCES runtimes(id),
  from_instance TEXT NOT NULL,
  to_instance TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'criu-leave-running',
  status TEXT DEFAULT 'pending',
  checkpoint_ms INTEGER,
  transfer_ms INTEGER,
  restore_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runtimes_user_id ON runtimes(user_id);
CREATE INDEX IF NOT EXISTS idx_runtimes_state ON runtimes(state);
CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_migrations_runtime_id ON migrations(runtime_id);
