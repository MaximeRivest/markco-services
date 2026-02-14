# feuille.dev API Contracts

Cross-service contracts currently used by orchestrator and platform flows.

## Auth service (`:3001`)

### Health
- `GET /health`

### Auth/session
- `POST /auth/github` — exchange OAuth code
- `GET /auth/validate` — validate session token
- `POST /auth/logout` — invalidate session token

### Invites
- `POST /invites`
- `GET /invites/:token`
- `DELETE /invites/:token`

## Compute manager (`:3002`)

### Health
- `GET /health`

### Runtime lifecycle
- `POST /runtimes` body: `{ user_id, plan?, language? }`
- `GET /runtimes/:userId`
- `DELETE /runtimes/:userId`

### Elasticity and snapshots
- `POST /runtimes/:userId/migrate` body: `{ target_type }`
- `POST /runtimes/:userId/snapshot` body: `{ name? }`
- `POST /runtimes/:userId/restore` body: `{ snapshot_id }`
- `POST /runtimes/:userId/sandbox`
- `DELETE /runtimes/:userId/sandbox/:sandboxId`

## Resource monitor (`:3004`)

### Health/status
- `GET /health`
- `GET /status`

### Registration
- `POST /monitor` body: `{ runtime_id, container_name, host?, memory_limit? }`
- `DELETE /monitor/:runtimeId`

### Eventing
- `POST /events/webhook` body: `{ url }`
- `GET /events/recent`
- `POST /analyze` body: `{ code, runtime_id, container_name?, host? }`

### Event payload types sent to orchestrator
- `pre-provision`
- `migrate`
- `urgent-migrate`
- `critical`
- `idle-sleep`
- `idle-wake`
- `gpu-hint`
- `big-ram-hint`

## Orchestrator (`:3000`)

### User-facing
- `/login`
- `/auth/callback/github`
- `/dashboard`
- `/u/:userId/*` (authenticated reverse proxy to editor container)

### Internal
- `GET /api/health`
- `GET /api/services`
- `POST /hooks/resource` (resource-monitor webhook target)

## Compatibility rule

When route contracts change in any service, update this doc and the corresponding service README/changelog in the same change.
