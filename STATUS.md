# Feuille Platform Status

> Last updated: 2026-02-09
>
> Canonical docs are being moved to `feuille-services/docs/`:
> - `docs/README.md`
> - `docs/00-quick-explain.md`
> - `docs/10-architecture-overview.md`
> - `docs/20-production-instance.md`
> - `docs/30-runbook.md`
> - `docs/40-api-contracts.md`

## Server

- **EC2:** t3.large (2 vCPU, 8GB RAM), ca-central-1b
- **Instance ID:** i-04210339d6c067c47, name `feuille-base`
- **OS:** Ubuntu 24.04
- **IP:** `16.52.74.84` (no Elastic IP — changes on stop/start)
- **SSH:** `ssh -i ~/.ssh/feuille-key.pem ubuntu@16.52.74.84`

> Previously t3.small (2GB). Upgraded to t3.large to support building R + Julia packages from source.

## What's Running

All services managed by a single systemd unit (`feuille.service`) that starts the orchestrator, which spawns the 4 Layer 3 services as child processes.

```
systemctl status feuille          # check status
sudo journalctl -u feuille -f     # tail logs
sudo systemctl restart feuille    # restart everything
```

| Service | Port | Status |
|---------|------|--------|
| Caddy (reverse proxy) | 80 | systemd `caddy.service` |
| Orchestrator | 3000 | systemd `feuille.service` (parent) |
| Auth Service | 3001 | child of orchestrator |
| Compute Manager | 3002 | child of orchestrator |
| Publish Service | 3003 | child of orchestrator |
| Resource Monitor | 3004 | child of orchestrator |
| PostgreSQL | 5432 | systemd `postgresql.service` |

## Container Architecture

Two container types per user, both using `--network=host`:

### Editor Container (`mrmd-editor:latest`, ~2.5 GB)

Runs **mrmd-server** (Node.js) serving the full editor UI. Contains:

- **Node.js 22** — mrmd-server, mrmd-sync, mrmd-project, mrmd-electron services
- **Python 3** — available for local session spawning
- **R + Rscript** — mrmd-r package at `/app/mrmd-r/`, R packages (httpuv, jsonlite, evaluate, later)
- **Julia 1.11** — mrmd-julia package at `/app/mrmd-julia/`, precompiled deps in `/app/.julia/`
- **Bash** — mrmd-bash spawned by mrmd-server as child process
- **uv** — fast Python package manager

The editor container spawns **bash, R, Julia, and PTY sessions as child processes** (same as desktop mrmd-electron). Python sessions go to the separate runtime container via `CloudSessionService`.

Key env vars: `CLOUD_MODE=1`, `RUNTIME_PORT=<port>`, `PORT=<port>`, `BASE_PATH=/u/<userId>/`, `JULIA_DEPOT_PATH=/app/.julia`

### Runtime Container (`mrmd-runtime:latest`, ~685 MB)

Runs **mrmd-python** with MRP protocol. Ubuntu 24.04 based with:

- Python 3 + venv at `/opt/venv`
- mrmd-python installed as CLI (`mrmd-python --foreground --port 8888`)
- uv for package management

Port 8888 inside container, mapped to random host port via `-p <hostPort>:8888`.

### Container Lifecycle

```
User visits /dashboard
  → orchestrator.onUserLogin()
  → compute-manager creates runtime container (random port)
  → orchestrator creates editor container (random port, --replace flag)
  → waitForHealth() on editor
  → Caddy routes /u/<userId>/* to orchestrator, which proxies to editor
```

## Request Flow

```
Browser → Caddy (:80) → Orchestrator (:3000)
                           ├─ /u/<userId>/* → HTTP reverse proxy → Editor container
                           │                  (strips /u/<userId> prefix)
                           ├─ /u/<userId>/* (WebSocket upgrade) → WS proxy → Editor container
                           ├─ /dashboard → dashboard HTML
                           ├─ /login → login page
                           └─ /auth/* → auth-service

Editor container (mrmd-server)
  ├─ /api/* → REST API (project, session, file, bash, r, julia, pty, etc.)
  ├─ /events → WebSocket for push notifications
  ├─ /sync/<port>/<doc> → Yjs CRDT sync (proxied from browser via http-shim)
  ├─ /proxy/<port>/<path> → proxy to local runtime services (bash, pty, etc.)
  ├─ / → index.html (editor UI with <base href>, MRMD_SERVER_URL injection)
  └─ static assets (mrmd.iife.js, http-shim.js, fonts, icons)
```

### URL Rewriting (Cloud Mode)

The editor runs behind a reverse proxy at `/u/<userId>/`. To make this work:

1. **`<base href="/u/<userId>/">`** injected into index.html so relative paths resolve correctly
2. **`window.MRMD_SERVER_URL`** set to `origin + "/u/<userId>/"` before http-shim.js loads
3. **http-shim.js** strips leading `/` from all API/WebSocket/sync/proxy paths so `new URL(path, BASE_URL)` resolves relative to the base path (not the origin root)
4. **Orchestrator HTTP proxy** (`router.use('/u/:userId', ...)`) strips the prefix and forwards to the editor container
5. **Orchestrator WS proxy** (`server.on('upgrade', ...)`) handles WebSocket upgrade for `/u/<userId>/*` paths, authenticates via cookie, and proxies bidirectionally to the editor container

## Caddy Routing

Caddy config generated dynamically by orchestrator on startup:

```
/@*                → publish-service (3003)
/auth/callback/*   → orchestrator (3000)  ← OAuth callbacks
/auth/*            → auth-service (3001)
/join/*            → auth-service (3001)
/api/*             → orchestrator (3000)
/login, /dashboard, /hooks/*, /projects/*, /u/*  → orchestrator (3000)
/*                 → orchestrator (3000, fallback)
```

> Note: `/u/*` goes to the orchestrator (not directly to editor containers). The orchestrator handles authentication and proxying internally. No per-user Caddy routes needed.

## File Locations on Server

```
/opt/feuille/feuille-services/    # all service code (orchestrator, auth, compute, publish, monitor)
/opt/feuille/editor-build/        # editor container build context
  ├── Dockerfile                  # editor container Dockerfile
  ├── mrmd-electron/              # editor UI + services
  ├── mrmd-server/                # HTTP server
  ├── mrmd-project/               # project config parsing
  ├── mrmd-sync/                  # Yjs CRDT server
  ├── mrmd-r/                     # R runtime package
  └── mrmd-julia/                 # Julia runtime package
/opt/feuille/Dockerfile.runtime   # runtime container Dockerfile
/opt/feuille/static/              # static assets (mrmd-reader.iife.js)
/data/users/<userId>/             # per-user data directory (volume-mounted into containers)
/etc/caddy/Caddyfile              # Caddy base config (admin API only, real config via API)
/etc/systemd/system/feuille.service  # systemd unit
```

## Database

PostgreSQL `feuille` database, 6 tables:
- `users` — id, email, name, github_id, google_id, plan, avatar_url
- `sessions` — user_id, token, expires_at
- `invites` — project_path, token, role, created_by
- `runtimes` — user_id, container_name, host, port, state, memory
- `snapshots` — user_id, runtime_id, name, path, size
- `migrations` — runtime_id, from/to instance, checkpoint/transfer/restore ms

Connection: `postgresql://postgres:feuille@localhost:5432/feuille`

Test user: `Maxime Rivest` (github_id=10967951, id=31bdffb9-39c5-4ed6-b4c7-5f16c9958045)

## OAuth

### GitHub (working)
- Client ID: `Ov23liM4fA4d5GE5Jbc1`
- Client Secret: in systemd env (`/etc/systemd/system/feuille.service`)
- Callback: `http://16.52.74.84/auth/callback/github`
- Flow: `/login` → GitHub → `/auth/callback/github` → `/dashboard`

> Callback URL needs updating in GitHub OAuth app settings when IP changes.

### Google (not yet)
- Needs a real domain — Google rejects bare IP redirect URIs
- Auth service has stub at `POST /auth/google` (returns 501)

## What Works End-to-End

### Layer 1: Infrastructure ✅
- EC2, Podman, Caddy, PostgreSQL all working
- **CRIU 4.2** installed and working (checkpoint/restore verified)
- **4GB swap** configured as safety net
- **IAM role** attached for EC2 provisioning

### Layer 2: Containers ✅
- **Editor container** serves full mrmd UI (index.html + CodeMirror + all assets)
- **Runtime container** runs mrmd-python with MRP protocol
- Both containers start automatically on user login
- Volume mounts for user data (`/data/users/<userId>/ → /home/user`)

### Layer 3: Services ✅
- **auth-service**: GitHub OAuth login, session tokens, token validation
- **compute-manager**: creates runtime containers, CRIU checkpoint/restore/migrate/snapshot/sandbox, tracks in Postgres
- **publish-service**: `/@user/project` renders with mrmd-reader, nav, code blocks
- **resource-monitor**: registers containers, polls stats every 5s, emits threshold events to orchestrator via webhook

### Layer 4: Orchestrator ✅ (core flow)
- User login → auto-start editor + runtime containers
- Caddy routing → orchestrator → HTTP/WS proxy → editor container
- Dashboard shows user info, "Open Editor" link
- Concurrency protection (per-user start lock, `--replace` flag)

### Working Runtimes in Editor

| Runtime | Status | How it works |
|---------|--------|--------------|
| **JavaScript** | ✅ Working | Browser-side (mrmd-js), no server needed |
| **Python** | ✅ Working | CloudSessionService → runtime container MRP port |
| **Bash** | ✅ Working | Spawned as child process in editor container |
| **R** | ✅ Working | Spawned as child process in editor container (Rscript + mrmd-r) |
| **Julia** | ⚠️ Partially | Installed in container, precompiled, but session start may fail |

### Other Working Features
- **Publishing:** `http://16.52.74.84/@maxime/hello` renders with mrmd-reader
- **File operations:** create, scan, open files via API
- **Sync:** mrmd-sync (Yjs CRDT) server spawned per project
- **AI service:** mrmd-ai-server starts lazily
- **WebSocket events:** file watching, push notifications
- **Proxy interceptors:** http-shim.js rewrites localhost fetch/WebSocket to go through server proxy

## What Doesn't Work Yet

### Near-term
1. **Julia sessions** — precompilation works but session startup may timeout; needs debugging
2. **Sync WebSocket** — `ws://.../u/<userId>/sync/<port>/<doc>` returns 502; the orchestrator WS proxy connects to the editor, but the editor's sync proxy to the internal sync server port may not work through the chain
3. **Google OAuth** — needs real domain
4. **IP changes on reboot** — no Elastic IP; GitHub OAuth callback URL must be updated manually

### CRIU Elastic Compute ✅ (tested)
- **Snapshot**: checkpoint → disk in ~600ms (5MB idle runtime)
- **Restore**: from snapshot to running in ~800ms, with new port mapping
- **Sandbox fork**: CRIU `--leave-running` clone, both run independently, sandbox destroyable
- **Cross-EC2 migration**: checkpoint → SCP (same AZ, ~0.5s) → restore on different instance → MRP works. Total ~3.5s.
- **Runtime AMI**: `ami-075cdf252eaacec79` (Ubuntu 24.04 + Podman + CRIU + mrmd-runtime:latest)
- **Security group**: `sg-073bb39d9229b6c9f` (feuille-runtime, allows SSH + ports from base)
- **SSH key**: `/home/ubuntu/.ssh/feuille-runtime` (ed25519, baked into AMI)
- **Hot-reload**: editor's `/api/runtime/update-port` endpoint updates Python MRP routing (port + host) without restart
- **Remote runtime support**: CloudSessionService + `/proxy/:port` route to configurable host (not hardcoded 127.0.0.1)
- **EC2 cleanup**: migration terminates old EC2 if source was remote; stopRuntime terminates EC2 too
- **AppArmor fix**: runtime containers use `--security-opt apparmor=unconfined` for CRIU compatibility

### Medium-term (Layer 4 completion)
5. **Auto-migration on memory pressure** — threshold events flow (resource-monitor → webhook → orchestrator), but not yet stress-tested in production with real memory pressure
6. **Idle timeout** — resource-monitor detects idle (CPU < 1% for 15 min), event-handler routes to `onIdleSleep` → `onUserIdle`. Needs production testing.
7. **User return/restore** — `onUserReturn` wired. Dashboard needs to detect idle state and call it on visit.
8. **Multi-user** — architecture supports it but only tested with one user
9. **Scale-down** — no path to migrate back from bigger EC2 to local when memory drops
10. **GPU instances** — no GPU AMI built, `g4dn.xlarge` not tested
11. **Pre-provisioning** — `onPreProvision` at 50% launches EC2 but doesn't save it for `onMigrate` to reuse

### Longer-term (Layer 5: UI)
9. **Publishing polish** — code blocks show play/copy/close buttons in reader mode (should be hidden), no active page highlighting in nav
10. **Share/invite UI** — no UI yet, invite API exists
11. **Compute indicator** — no UI showing runtime tier
12. **Custom domains** — needs real DNS (feuille.dev)
13. **CloudFront CDN** — not set up yet, static assets served directly

## Rebuilding

### Editor container
```bash
# On local machine: sync updated files to server build context
rsync -avz --exclude='node_modules' --exclude='.git' \
  mrmd-server/ -e "ssh -i ~/.ssh/feuille-key.pem" \
  ubuntu@16.52.74.84:/opt/feuille/editor-build/mrmd-server/

# On server (or via SSH): rebuild
cd /opt/feuille/editor-build && sudo podman build -t mrmd-editor:latest -f Dockerfile .

# For long builds, run detached so SSH disconnect doesn't kill it:
nohup bash -c "cd /opt/feuille/editor-build && sudo podman build -t mrmd-editor:latest -f Dockerfile . > /tmp/build.log 2>&1" &
tail -f /tmp/build.log
```

### Runtime container
```bash
# On server:
sudo podman build -t mrmd-runtime:latest -f /opt/feuille/Dockerfile.runtime /tmp/
```

### Deploying orchestrator changes (no rebuild needed)
```bash
# Copy updated files to server
scp -i ~/.ssh/feuille-key.pem \
  feuille-services/orchestrator/src/*.js \
  ubuntu@16.52.74.84:/tmp/

ssh -i ~/.ssh/feuille-key.pem ubuntu@16.52.74.84 '
  sudo cp /tmp/*.js /opt/feuille/feuille-services/orchestrator/src/
  sudo podman rm -f $(sudo podman ps -aq) 2>/dev/null
  sudo -u postgres psql feuille -qc "DELETE FROM runtimes"
  sudo systemctl restart feuille
'
```

## Key Code Changes (not yet committed)

All changes in local repo at `/home/maxime/Projects/mrmd-packages/`:

### feuille-services/ (orchestrator & infra)
- `orchestrator/src/index.js` — WebSocket proxy for `/u/<userId>/*`, imports ws library
- `orchestrator/src/routes/main.js` — HTTP reverse proxy to editor containers (replaced Caddy dynamic routes)
- `orchestrator/src/user-lifecycle.js` — `--replace` flag, `BASE_PATH` env var, concurrency lock, removed Caddy addRoute/removeRoute calls
- `orchestrator/src/caddy-config.js` — added `/u/*` to orchestrator-pages route
- `orchestrator/src/caddy.js` — simplified (dynamic routes no longer needed for users)
- `orchestrator/package.json` — added `ws` dependency
- `Dockerfile.editor` — R, Julia, mrmd-r, mrmd-julia, Julia precompilation as node user

### mrmd-server/
- `src/server.js` — `<base href>` injection, `MRMD_SERVER_URL` script tag, relative paths in cloud mode (`pathPrefix`)
- `src/cloud-session-service.js` — use `/mrp/v1/capabilities` instead of `/mrp/v1/status` (which doesn't exist)
- `static/http-shim.js` — strip leading `/` from API paths, sync/proxy/events URLs (so `new URL()` resolves relative to BASE_URL path)

### Previously changed (from earlier sessions)
- `feuille-services/auth-service/src/routes/auth.js` — handle non-JSON GitHub responses
- `mrmd-python/src/mrmd_python/cli.py` — `--host` CLI argument
- `mrmd-python/src/mrmd_python/runtime_daemon.py` — configurable host

## Architecture Notes

### Current vs Build Plan

The architecture follows **Option A from the build plan**: separate editor + runtime containers. The editor container stays on the base server (low-latency WebSocket for typing), while runtime containers start co-located and can theoretically be CRIU-migrated to bigger EC2 instances.

**Key deviation:** R, Julia, and Bash run inside the editor container (not the runtime container). This is because mrmd-server's session services spawn them as child processes. Only Python uses the separate runtime container via CloudSessionService. This works fine for now — these runtimes don't need elastic scaling like Python (which is where heavy ML workloads run).

### Proxy Chain

```
Browser
  ↓ HTTP/WS
Caddy (:80)
  ↓ reverse_proxy to :3000
Orchestrator (Express + WS)
  ↓ HTTP proxy (strips /u/<userId>) or WS proxy (bidirectional)
Editor Container (mrmd-server on random port)
  ↓ child process spawn (bash, R, Julia, PTY)
  ↓ HTTP fetch to runtime container (Python MRP)
Runtime Container (mrmd-python on random port mapped to :8888)
```

### http-shim.js Proxy Chain

The browser's http-shim.js intercepts certain requests:

```
Browser code calls fetch("http://127.0.0.1:39629/mrp/v1/execute")
  → http-shim intercepts (localhost match)
  → rewrites to: http://16.52.74.84/u/<userId>/proxy/39629/mrp/v1/execute
  → Caddy → Orchestrator → Editor container → /proxy/39629/... → localhost:39629

Browser code calls new WebSocket("ws://127.0.0.1:35367/01-index")
  → http-shim intercepts (localhost match)
  → rewrites to: ws://16.52.74.84/u/<userId>/sync/35367/01-index
  → Caddy → Orchestrator WS proxy → Editor container WS
```
