# Spec: Cloud Sync Relay (Step 1)

> Written: 2026-02-14
> Status: Ready to build
> Prereq: [52-engineering-roadmap.md](./52-engineering-roadmap.md)
> Scope: 1-2 weeks

## Goal

A persistent Yjs sync service that runs alongside the other markco-services, stores document state in Postgres, authenticates connections, and survives container restarts. When this is done, a user's documents persist independently of their editor container.

## What Exists Today

### mrmd-sync (the open-source library)

`mrmd-sync` is a standalone Yjs sync server (1,441 lines). It:

- Accepts WebSocket connections at `ws://host:port/<docName>`
- Manages Yjs documents in memory with full sync protocol (sync step 1/2, awareness)
- Persists to the **local filesystem**: `atomicWriteFile()` writes markdown to disk
- Crash recovery via **Yjs snapshots**: `saveYjsSnapshot()` writes base64-encoded Yjs state to temp dir
- File watching via **chokidar**: external file edits → Yjs updates (bidirectional)
- Debounced writes (default 1s), configurable
- Document cleanup after all clients disconnect (default 60s delay)
- Auth hook: `createServer({ auth: async (req, docName) => bool })`
- Health/metrics/stats HTTP endpoints
- Graceful shutdown with pending write flush
- Memory monitoring (added after a data loss incident)

### How it's used today

In the **editor container**, `mrmd-server/src/sync-manager.js` spawns one `mrmd-sync` process per project directory:

```
mrmd-server starts
  → user opens a project
  → sync-manager spawns: node mrmd-sync --port <random> /home/node/myproject
  → browser connects: ws://localhost:<port>/01-index
  → edits flow: browser ↔ mrmd-sync ↔ filesystem
```

The sync server runs **inside** the editor container with `--no-auth`. It persists to the container's filesystem. When the container dies, the Yjs state is lost (the filesystem writes survive only if they're on a mounted volume — which we just fixed).

### The gap

- **No cloud persistence**: Yjs state lives on the container's disk. No independent backup.
- **No multi-device**: Each container has its own sync server. A phone can't connect to it (no auth, container may be sleeping).
- **No shared state**: If we restart a container, the sync server restarts, all WebSocket connections drop, and if Yjs snapshots weren't flushed, edits can be lost.

## Architecture

### Where the sync relay fits

```
                    markco-services (all on one EC2)
                    ┌───────────────────────────────────────┐
                    │  orchestrator        :3000             │
                    │  auth-service        :3001             │
                    │  compute-manager     :3002             │
                    │  publish-service     :3003             │
                    │  resource-monitor    :3004             │
 NEW ───────────→   │  sync-relay          :3005             │
                    └───────────────────────────────────────┘
                                    ↕
                              PostgreSQL :5432
                         (new table: documents)
```

The sync relay is a **new Layer 3 service**, managed by the orchestrator process-manager just like the other services.

### Connection flow (cloud editor)

Today:
```
Browser → orchestrator → editor container → mrmd-sync (inside container)
```

After Step 1:
```
Browser → orchestrator → sync-relay (shared service, Postgres-backed)
                              ↕
                     editor container filesystem (still used for file ops)
```

The editor container **still has the files on disk** (for file operations, project detection, asset serving). But Yjs sync goes through the relay instead of a per-container sync server.

### Connection flow (future: desktop Electron, phone)

```
Desktop Electron → sync-relay (direct WebSocket to markco.dev)
Phone PWA        → sync-relay (direct WebSocket to markco.dev)
Cloud editor     → sync-relay (via orchestrator proxy)
```

All three clients connect to the same relay, same documents. This is what Step 1 enables but Steps 3-4 implement.

## Detailed Design

### 1. New service: `markco-services/sync-relay/`

```
sync-relay/
  package.json
  src/
    index.js          # Express + WebSocket server on :3005
    db.js             # Postgres pool (shared connection string)
    schema.sql        # documents table
    yjs-store.js      # load/save Yjs state from/to Postgres
    routes/
      sync.js         # HTTP endpoints (health, stats, list docs)
  test/
    sync-relay.test.js
```

### 2. Database schema

```sql
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  project TEXT NOT NULL,          -- e.g. "myproject"
  doc_path TEXT NOT NULL,         -- e.g. "01-index" (without .md)
  yjs_state BYTEA,               -- Y.encodeStateAsUpdate() binary
  content_text TEXT,              -- plain text snapshot (for search, preview, debugging)
  content_hash TEXT,              -- MD5 of content_text (change detection)
  byte_size INTEGER DEFAULT 0,   -- size of yjs_state in bytes
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, project, doc_path)
);

CREATE INDEX IF NOT EXISTS idx_documents_user_project 
  ON documents(user_id, project);
CREATE INDEX IF NOT EXISTS idx_documents_updated 
  ON documents(updated_at);
```

**Why both `yjs_state` and `content_text`?**
- `yjs_state` (BYTEA): the full Yjs document state as binary. This is what gets loaded into Y.Doc on connection. It preserves all CRDT history needed for correct merging.
- `content_text` (TEXT): the plain markdown string. Useful for: search, publishing, debugging, showing document previews without loading the full Yjs state. Updated alongside `yjs_state`.

**Sizing:** A typical document's Yjs state is 2-10x the text size (due to CRDT metadata). A 10KB markdown file → ~50KB Yjs state. Postgres handles this easily. Even 10,000 documents at 50KB each = 500MB, well within a single Postgres instance.

### 3. Document naming convention

Documents are keyed by: `userId/project/docPath`

```
WebSocket URL: ws://markco.dev/sync/<userId>/<project>/<docPath>

Examples:
  ws://markco.dev/sync/31bdffb9-.../myproject/01-index
  ws://markco.dev/sync/31bdffb9-.../myproject/02-analysis/01-data
```

The relay parses the URL to extract `userId`, `project`, and `docPath`, then uses these as the Postgres key.

### 4. Authentication

The WebSocket connection must be authenticated. Two methods:

**Method A: Cookie (browser via orchestrator)**
- Browser already has a `session_token` cookie
- Orchestrator validates the cookie, then proxies the WebSocket to the relay
- Orchestrator adds `X-User-Id` header on the proxied connection
- Relay trusts this header (internal network only)

**Method B: Token query param (future: Electron, phone)**
- Client connects with `ws://markco.dev/sync/...?token=<session_token>`
- Relay validates the token against auth-service
- For now, only Method A is needed (browser goes through orchestrator)

### 5. Yjs state management

The sync relay manages Yjs documents in memory (like mrmd-sync does today) but with a Postgres backend instead of the filesystem.

#### Document lifecycle

```
1. First connection to a document
   → Check Postgres for existing yjs_state
   → If found: Y.applyUpdate(ydoc, state) — document loads with full history
   → If not found: create empty Y.Doc
   → Client connects, sync protocol begins

2. Client edits
   → Yjs update flows to all connected clients (broadcast, same as today)
   → Debounced save to Postgres (default: 2 seconds)
   → Save both yjs_state (binary) and content_text (plain text)

3. All clients disconnect
   → Flush pending write to Postgres immediately
   → Keep Y.Doc in memory for docCleanupDelayMs (default: 60s)
   → If no reconnection: destroy Y.Doc, free memory
   → Document is safely in Postgres

4. Reconnection
   → If Y.Doc still in memory: reuse it (fast path)
   → If cleaned up: reload from Postgres (same as step 1)
```

#### Save strategy

```javascript
// Debounced save to Postgres (inside the Yjs update handler)
const saveToPg = debounce(async (docData) => {
  const yjsState = Y.encodeStateAsUpdate(docData.ydoc);
  const text = docData.ytext.toString();
  const hash = md5(text);
  
  await pool.query(`
    INSERT INTO documents (user_id, project, doc_path, yjs_state, content_text, content_hash, byte_size, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (user_id, project, doc_path)
    DO UPDATE SET yjs_state = $4, content_text = $5, content_hash = $6, byte_size = $7, updated_at = NOW()
  `, [userId, project, docPath, Buffer.from(yjsState), text, hash, yjsState.byteLength]);
}, 2000);
```

The `ON CONFLICT ... DO UPDATE` (upsert) means we never have to worry about insert vs update logic.

### 6. Filesystem sync (editor container ↔ relay)

This is the trickiest part. Today, mrmd-sync syncs bidirectionally with the filesystem (Yjs ↔ .md files). The relay replaces the Yjs side, but the editor container still needs files on disk for:

- File operations (create, delete, rename via mrmd-server API)
- Project detection (`mrmd.md` config file)
- Asset serving (images, plots)
- Runtime working directory (bash, Python, R, Julia all read/write files)

**Approach: the editor container connects to the relay as a Yjs client.**

```
Editor container starts
  → mrmd-server detects CLOUD_MODE=1
  → Instead of spawning mrmd-sync, connects to relay via WebSocket
  → For each open document:
      - Relay sends Yjs state → mrmd-server applies to local Y.Doc
      - Local Y.Doc writes to filesystem (like today's mrmd-sync does)
      - Filesystem changes → local Y.Doc → Yjs update → relay → other clients
```

This means the editor container acts as a **Yjs client** that also does filesystem I/O. It's a thin adapter that:
1. Connects to the relay WebSocket
2. Maintains a local Y.Doc that syncs with the relay
3. Writes Y.Doc content to the local filesystem (for runtimes to use)
4. Watches the local filesystem for external changes (for runtimes that write output)

**Implementation:** This can reuse most of mrmd-sync's existing code. The `getDoc()` function already does file ↔ Yjs bidirectional sync. We just need to add a "relay mode" where instead of being the WebSocket server, it's a WebSocket client that connects to the relay.

**New module in mrmd-sync:** `src/relay-client.js`

```javascript
// Connects to a remote sync relay and syncs a local directory
export function createRelayClient({ relayUrl, projectDir, userId, project, token }) {
  // For each .md file in projectDir:
  //   1. Open WebSocket to relayUrl/userId/project/docPath
  //   2. Sync local Y.Doc with relay (standard Yjs sync protocol)
  //   3. On local Y.Doc update → write to filesystem
  //   4. On filesystem change → update local Y.Doc → relay gets the update
}
```

### 7. Orchestrator WebSocket routing

The orchestrator already handles WebSocket upgrades for `/u/:userId/*`. Currently it proxies sync WebSockets to the editor container. We change it to proxy to the sync relay instead.

**Current** (in `orchestrator/src/index.js`):
```
server.on('upgrade', ...) {
  // /u/:userId/sync/:port/:doc → proxy to editor container
}
```

**New:**
```
server.on('upgrade', ...) {
  // /u/:userId/sync/:project/:doc → proxy to sync-relay :3005
  //   with X-User-Id header added
}
```

The URL format changes slightly:
- Old: `/u/:userId/sync/:port/:doc` (port was the per-container sync server port)
- New: `/u/:userId/sync/:project/:doc` (project name, relay handles the rest)

This also means **http-shim.js** needs a small update to construct the new URL format.

### 8. HTTP API

The sync relay also exposes HTTP endpoints (for health checks, stats, and future use by the UI):

```
GET  /health                           → { status: 'ok' }
GET  /stats                            → { connections, documents, memory }
GET  /api/documents/:userId            → list user's documents (for project listing)
GET  /api/documents/:userId/:project   → list documents in a project
```

These are authenticated via the same internal-service pattern (orchestrator proxies with `X-User-Id` header, or token validation).

### 9. Process management

The orchestrator's `process-manager.js` starts the sync relay alongside the other services:

```javascript
// In orchestrator/src/process-manager.js
const services = [
  { name: 'auth-service',     port: 3001, dir: '../auth-service' },
  { name: 'compute-manager',  port: 3002, dir: '../compute-manager' },
  { name: 'publish-service',  port: 3003, dir: '../publish-service' },
  { name: 'resource-monitor', port: 3004, dir: '../resource-monitor' },
  { name: 'sync-relay',       port: 3005, dir: '../sync-relay' },     // NEW
];
```

The orchestrator's Caddy config also needs to route sync WebSockets to the orchestrator (which then proxies to the relay). This is already the case since all `/u/*` traffic goes to the orchestrator.

## Edge Cases and Failure Modes

### Relay crashes or restarts

- All WebSocket connections drop
- Clients (editor containers, future: Electron/phone) reconnect automatically
- On reconnect, Y.Doc is reloaded from Postgres
- No data loss (last flush was ≤2 seconds ago)
- **Mitigation:** mrmd-sync already handles reconnection gracefully on the client side

### Postgres is slow or down

- In-memory Y.Doc continues to work (clients can still edit)
- Postgres writes fail → retry with exponential backoff
- Log warnings: "Postgres write failed, retrying..."
- If Postgres is down for >5 minutes, log critical alert
- **Data is still safe in-memory** — only lost if relay also crashes while Postgres is down
- **Mitigation:** on startup, check Postgres health before accepting connections

### Editor container restarts while relay is running

- Container reconnects as a new Yjs client
- Relay sends current document state
- Container writes to filesystem
- No data loss, no interruption for other clients (browser, future devices)
- This is the main improvement over today's architecture

### Two editor containers for the same user (shouldn't happen, but...)

- Both connect to the same relay documents
- Yjs CRDT handles concurrent edits correctly
- Both containers write to their own filesystem (independent)
- Only a problem if they share a volume mount (they'd fight over file writes)
- **Mitigation:** orchestrator's `--replace` flag prevents this

### Large documents

- Yjs state grows over time (CRDT history)
- A 10KB document might have a 200KB Yjs state after heavy editing
- Postgres BYTEA handles this fine (up to 1GB per value)
- Memory concern: each in-memory Y.Doc holds the full state
- **Mitigation:** document cleanup after disconnect (already implemented in mrmd-sync)
- **Future mitigation:** Yjs state compaction (reset CRDT history, keep current content). mrmd-sync already has `compactYDoc()` but it's disabled due to client reconnection issues. The relay could compact on scheduled maintenance when no clients are connected.

### Network partition between editor container and relay

- Container's relay client WebSocket drops
- Local edits continue (Y.Doc is in memory)
- Reconnect with automatic Yjs state merge
- No conflict, no data loss (CRDT guarantee)
- File writes continue locally during partition

## What Changes in Each Package

### markco-services/sync-relay/ (NEW)
- New service: ~300-400 lines
- Express HTTP + WebSocket server
- Postgres storage backend
- Auth validation (X-User-Id header or token)

### markco-services/orchestrator/
- `src/process-manager.js`: add sync-relay to service list
- `src/index.js`: update WebSocket upgrade handler to route sync to relay
- `src/caddy-config.js`: no change (sync traffic already goes through orchestrator)
- `src/user-lifecycle.js`: pass `SYNC_RELAY_URL` env var to editor container

### mrmd-server/
- `src/sync-manager.js`: in cloud mode, don't spawn mrmd-sync, connect to relay instead
- `src/server.js`: update sync WebSocket proxy to use new URL format
- `static/http-shim.js`: update sync URL construction (project name instead of port)

### mrmd-sync/ (optional enhancement)
- New `src/relay-client.js`: Yjs client that connects to a remote relay and syncs with local filesystem
- This is the reusable component for the editor container's relay connection
- Could also be used by desktop Electron in Step 3

### Database
- New `documents` table (see schema above)
- Migration: `sync-relay/src/schema.sql` applied on service startup

## Testing Plan

### Unit tests (`sync-relay/test/`)

1. **Postgres round-trip**: save Yjs state → load → verify content matches
2. **Document lifecycle**: connect → edit → disconnect → reconnect → verify state persisted
3. **Auth rejection**: connect without valid token → connection refused
4. **Concurrent clients**: two clients connect to same doc → edits sync correctly
5. **Debounced save**: rapid edits → verify Postgres writes are batched

### Integration test

1. Start sync relay + Postgres
2. Connect a Yjs client (simulating browser)
3. Make edits
4. Kill the relay
5. Restart the relay
6. Connect again
7. Verify all edits are present

### Smoke test on EC2

1. Deploy sync relay as new service
2. Update orchestrator routing
3. Open editor in browser → edit a document
4. Restart the editor container: `sudo podman rm -f editor-*`
5. Open editor again → verify document content is intact
6. Check Postgres: `SELECT doc_path, length(content_text) FROM documents;`

## Rollback Plan

If the relay has issues, we can revert to per-container mrmd-sync with one config change:
- Set `SYNC_RELAY_URL=""` (empty) → mrmd-server falls back to spawning local mrmd-sync
- No code changes needed, just an env var

## Success Criteria

Step 1 is done when:

1. ✅ sync-relay runs as a markco-services service on port 3005
2. ✅ Yjs state persists in Postgres `documents` table
3. ✅ Browser editor syncs through the relay (not per-container mrmd-sync)
4. ✅ Restarting an editor container does NOT lose document content
5. ✅ `SELECT count(*) FROM documents WHERE user_id = '...'` shows saved documents
6. ✅ Latency is imperceptible (sub-100ms for Yjs updates through relay)
7. ✅ Graceful degradation: if relay is down, editor still works (local fallback)
