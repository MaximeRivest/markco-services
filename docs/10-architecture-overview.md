# markco.dev Architecture Overview

This is the canonical architecture summary for the platform layer currently staged in `markco-services/`.

## Services and ports

- `orchestrator` (`:3000`) — platform entrypoint + user proxy + lifecycle coordinator
- `auth-service` (`:3001`) — OAuth/session/invite APIs + user/session tables
- `compute-manager` (`:3002`) — runtime container lifecycle + CRIU migration/snapshot APIs
- `publish-service` (`:3003`) — published pages `@user/project`
- `resource-monitor` (`:3004`) — stats polling + threshold/idle/gpu events
- PostgreSQL (`:5432`) — shared platform state
- Caddy (`:80`/`:443`) — public edge reverse proxy

## Login-to-editor flow

1. Browser hits `/login` (orchestrator), redirected to GitHub OAuth
2. Callback handled by orchestrator -> `auth-service` code exchange
3. Orchestrator starts user runtime via `compute-manager`
4. Orchestrator starts user editor container (`mrmd-server` in cloud mode)
5. Browser opens `/dashboard` and then `/u/<userId>/`
6. Orchestrator proxies `/u/<userId>/*` HTTP + WS to user editor container

## Runtime/editor split

Per user there are two container roles:

- **Runtime container (`mrmd-runtime`)**
  - runs `mrmd-python`
  - CRIU checkpoint/migration target
- **Editor container (`mrmd-editor`)**
  - runs `mrmd-server`
  - interactive UI/API path
  - started with env: `CLOUD_MODE=1`, `RUNTIME_PORT=<port>`, `BASE_PATH=/u/<userId>/`

## Request and proxy chain

Browser -> Caddy -> Orchestrator -> Editor container (`mrmd-server`) -> runtime/process endpoints

Inside editor container, `http-shim.js` rewrites localhost calls to container-relative `/proxy/*` or `/sync/*` paths.

## Event chain for elasticity

Resource monitor emits events (via webhook) to orchestrator:
- `pre-provision` (50%)
- `migrate` (75%)
- `urgent-migrate` (90%)
- `critical` (95%)
- `idle-sleep` / `idle-wake`
- `gpu-hint`

Orchestrator maps these to runtime lifecycle handlers (`runtime-lifecycle.js`) and compute-manager operations.

## State and persistence

- Postgres tables track users/sessions/runtimes/snapshots/migrations
- user files are mounted from `/data/users/<userId>/`
- snapshot artifacts stored under `/data/snapshots/...`
