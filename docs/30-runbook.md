# markco.dev Runbook

Operational runbook for the current platform stack.

## 1) Core service control

```bash
systemctl status markco
sudo journalctl -u markco -f
sudo systemctl restart markco
```

Caddy and Postgres:

```bash
systemctl status caddy
systemctl status postgresql
```

## 2) API-level health checks

Quick automated pass:

```bash
BASE_URL=http://localhost markco-services/scripts/smoke.sh
```


- orchestrator health: `GET /api/health`
- service detail: `GET /api/services`
- direct service health:
  - `http://localhost:3001/health`
  - `http://localhost:3002/health`
  - `http://localhost:3004/health`

## 3) Runtime/editor incident triage

If user cannot open editor:

1. check orchestrator logs (`journalctl -u markco -f`)
2. verify user editor/runtime container creation in logs
3. verify `/dashboard` shows editor/runtime ports
4. test `/u/<userId>/` path and websocket upgrades

If runtime execution fails:

1. check compute-manager logs
2. verify runtime row in DB (`runtimes` table)
3. inspect container status on host (podman)
4. verify editor runtime mapping (`/api/runtime/update-port` used after migration)

## 4) Build/rebuild procedures

### Rebuild editor container image

```bash
cd /opt/markco/editor-build
sudo podman build -t mrmd-editor:latest -f Dockerfile .
```

Long build detached:

```bash
nohup bash -c "cd /opt/markco/editor-build && sudo podman build -t mrmd-editor:latest -f Dockerfile . > /tmp/build.log 2>&1" &
tail -f /tmp/build.log
```

### Rebuild runtime container image

```bash
sudo podman build -t mrmd-runtime:latest -f /opt/markco/Dockerfile.runtime /tmp/
```

### Deploy code changes

Use the deploy script (auto-detects changed files, deploys, restarts if needed, runs smoke tests):

```bash
./scripts/deploy.sh            # Deploy only changed files
./scripts/deploy.sh --static   # Static assets only (no restart)
./scripts/deploy.sh --services # Service code only (restarts markco)
./scripts/deploy.sh --all      # Force deploy everything
./scripts/deploy.sh --dry-run  # Preview what would change
```

The script compares local file hashes against the server to detect changes.
Static files (browser-shim.js, runtime scripts) don't require a restart.
Service files (orchestrator, auth, etc.) trigger `systemctl restart markco`.

> SSH key: `~/.ssh/feuille-key.pem` (override with `MARKCO_SSH_KEY` env var).
> Host: resolved from `dig +short markco.dev` (override with `MARKCO_HOST` env var).

#### Manual deploy (single file)

```bash
HOST=$(dig +short markco.dev)
scp -i ~/.ssh/feuille-key.pem orchestrator/src/routes/main.js ubuntu@$HOST:/tmp/
ssh -i ~/.ssh/feuille-key.pem ubuntu@$HOST '
  sudo cp /tmp/main.js /opt/markco/markco-services/orchestrator/src/routes/main.js
  sudo systemctl restart markco
'
```

## 5) Analytics (Umami)

```bash
systemctl status umami
sudo journalctl -u umami -f
sudo systemctl restart umami
```

Dashboard: `https://markco.dev/analytics/`

Umami runs as a Podman container (`ghcr.io/umami-software/umami:postgresql-latest`) on port 3005.
Caddy routes `/analytics/*`, `/script.js`, and `/api/send` to it.

## 6) Database quick checks

Platform DB: `markco` on local Postgres.
Analytics DB: `umami` on local Postgres (separate database, managed by Umami).

High-value tables (markco DB):
- `users`
- `sessions`
- `invites`
- `runtimes`
- `snapshots`
- `migrations`

## 7) Escalation notes

- If sync path breaks, prioritize data safety and disable affected access path until WS proxy is confirmed healthy.
- If migration chain fails, keep user on local runtime and avoid repeated migration loops.
