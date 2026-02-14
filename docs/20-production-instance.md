# Production Instance (Current)

Last synced from operational notes: **2026-02-09 STATUS snapshot**.

## Host baseline

- Cloud: AWS EC2
- Instance: `feuille-base`
- Instance ID: `i-04210339d6c067c47`
- Type: `t3.large` (2 vCPU, 8 GB RAM)
- Region/AZ: `ca-central-1b`
- OS: Ubuntu 24.04
- Public IP at snapshot time: `16.52.74.84` (not Elastic)

> Because there is no Elastic IP yet, callback/domain/IP-linked settings can drift after stop/start.

## Service topology on host

- Caddy: systemd `caddy.service`
- Platform stack: systemd `feuille.service`
  - orchestrator `:3000`
  - auth-service `:3001`
  - compute-manager `:3002`
  - publish-service `:3003`
  - resource-monitor `:3004`
- PostgreSQL: systemd `postgresql.service` (`:5432`)

## Container topology

Per user:

1. **Editor container** (`mrmd-editor:latest`)
   - runs `mrmd-server`
   - uses `--network=host`
   - spawns bash/R/Julia/PTY local child runtimes
   - receives env including `CLOUD_MODE=1`, `RUNTIME_PORT`, `BASE_PATH=/u/<userId>/`
2. **Runtime container** (`mrmd-runtime:latest`)
   - runs `mrmd-python`
   - exposed to host via random mapped port

## Data and filesystem locations

- service code: `/opt/feuille/feuille-services/`
- editor image build context: `/opt/feuille/editor-build/`
- runtime Dockerfile: `/opt/feuille/Dockerfile.runtime`
- static publish assets: `/opt/feuille/static/`
- user data roots: `/data/users/<userId>/`

## Current known issues (from status snapshot)

- Julia sessions may still fail in some cases
- sync websocket path had 502 failures in prior tests
- Google OAuth not active yet (domain requirements)
- public IP churn affects callback URLs

## Canonical update process

When infra/runtime behavior changes, update this file and `30-runbook.md` in same PR/deploy.
