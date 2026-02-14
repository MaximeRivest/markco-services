# feuille.dev Runbook

Operational runbook for the current platform stack.

## 1) Core service control

```bash
systemctl status feuille
sudo journalctl -u feuille -f
sudo systemctl restart feuille
```

Caddy and Postgres:

```bash
systemctl status caddy
systemctl status postgresql
```

## 2) API-level health checks

- orchestrator health: `GET /api/health`
- service detail: `GET /api/services`
- direct service health:
  - `http://localhost:3001/health`
  - `http://localhost:3002/health`
  - `http://localhost:3004/health`

## 3) Runtime/editor incident triage

If user cannot open editor:

1. check orchestrator logs (`journalctl -u feuille -f`)
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
cd /opt/feuille/editor-build
sudo podman build -t mrmd-editor:latest -f Dockerfile .
```

Long build detached:

```bash
nohup bash -c "cd /opt/feuille/editor-build && sudo podman build -t mrmd-editor:latest -f Dockerfile . > /tmp/build.log 2>&1" &
tail -f /tmp/build.log
```

### Rebuild runtime container image

```bash
sudo podman build -t mrmd-runtime:latest -f /opt/feuille/Dockerfile.runtime /tmp/
```

### Deploy orchestrator code changes

```bash
# copy changed files
scp -i ~/.ssh/feuille-key.pem feuille-services/orchestrator/src/*.js ubuntu@<host>:/tmp/

# apply + restart
ssh -i ~/.ssh/feuille-key.pem ubuntu@<host> '
  sudo cp /tmp/*.js /opt/feuille/feuille-services/orchestrator/src/
  sudo systemctl restart feuille
'
```

## 5) Database quick checks

Target DB: `feuille` on local Postgres.

High-value tables:
- `users`
- `sessions`
- `invites`
- `runtimes`
- `snapshots`
- `migrations`

## 6) Escalation notes

- If sync path breaks, prioritize data safety and disable affected access path until WS proxy is confirmed healthy.
- If migration chain fails, keep user on local runtime and avoid repeated migration loops.
