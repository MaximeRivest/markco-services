# Environment Contract

Canonical environment-variable reference for `feuille-services` platform components.

## 1) Orchestrator (`orchestrator`)

### Core
- `PORT` (default: `3000`)
- `DOMAIN` (default: `feuille.dev`)

### OAuth/UI routing
- `GITHUB_CLIENT_ID` (required for `/login` flow)

### Service endpoints (internal)
- `AUTH_SERVICE_URL` (default: `http://localhost:3001`)
- `COMPUTE_MANAGER_URL` (default: `http://localhost:3002`)
- `PUBLISH_SERVICE_URL` (default: `http://localhost:3003`)
- `RESOURCE_MONITOR_URL` (default: `http://localhost:3004`)
- `CADDY_ADMIN_URL` (default: `http://localhost:2019`)

### Storage/container behavior
- `DATA_DIR` (default: `/data/users`)
- `EDITOR_IMAGE` (default: `localhost/mrmd-editor:latest`)

## 2) Auth service (`auth-service`)

- `PORT` (default: `3001`)
- `DATABASE_URL` (default: `postgresql://localhost:5432/feuille`)
- `GITHUB_CLIENT_ID` (required for GitHub auth)
- `GITHUB_CLIENT_SECRET` (required for GitHub auth)

## 3) Compute manager (`compute-manager`)

- `PORT` (default: `3002`)
- `DATABASE_URL` (default: `postgresql://localhost:5432/feuille`)

### AWS/EC2 migration path
- `AWS_REGION` (default: `ca-central-1`)
- `RUNTIME_AMI_ID` (required for provision/migration)
- `SECURITY_GROUP_ID` (optional but expected in prod)
- `SUBNET_ID` (optional, VPC-dependent)
- `KEY_NAME` (optional, EC2 SSH key name)
- `SSH_KEY_PATH` (defaults differ in modules; set explicitly in prod)
- `SSH_USER` (default: `ubuntu`)

## 4) Resource monitor (`resource-monitor`)

- `PORT` (default: `3004`)
- `POLL_INTERVAL_MS` (default: `5000`)
- `IDLE_TIMEOUT_MINUTES` (default: `15`)

## 5) Publish service (`publish-service`)

- `PORT` (default: `3003`)
- `USERS_DIR` (default: `/data/users`)

## 6) Editor container env injected by orchestrator

When orchestrator launches user editor container (`mrmd-server`), it sets:

- `CLOUD_MODE=1`
- `RUNTIME_PORT=<runtime host port>`
- `PORT=<editor port>`
- `BASE_PATH=/u/<userId>/`

### User identity for cloud UI
- `CLOUD_USER_ID`
- `CLOUD_USER_NAME`
- `CLOUD_USER_EMAIL`
- `CLOUD_USER_AVATAR`
- `CLOUD_USER_PLAN`

## Operational recommendation

Pin all non-default production values in systemd unit env or env-file and version-control that template (without secrets).
