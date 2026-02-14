#!/usr/bin/env bash
#
# deploy.sh — Deploy markco-services to the production server
#
# Usage:
#   ./scripts/deploy.sh              # Deploy everything that changed
#   ./scripts/deploy.sh --static     # Static assets only (no restart)
#   ./scripts/deploy.sh --services   # Service code only (restarts markco)
#   ./scripts/deploy.sh --all        # Everything + restart
#   ./scripts/deploy.sh --dry-run    # Show what would be deployed
#
# Requires: SSH key at ~/.ssh/feuille-key.pem (or MARKCO_SSH_KEY env var)
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_KEY="${MARKCO_SSH_KEY:-$HOME/.ssh/feuille-key.pem}"
HOST="${MARKCO_HOST:-$(dig +short markco.dev 2>/dev/null || echo '52.60.156.234')}"
USER="ubuntu"
REMOTE="$USER@$HOST"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# Remote paths
REMOTE_SERVICES="/opt/markco/markco-services"
REMOTE_STATIC="/opt/markco/static/static"
REMOTE_CADDY="/etc/caddy/Caddyfile"

# ── Color helpers ──────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ── Parse args ─────────────────────────────────────────────────────────

MODE="auto"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --static)   MODE="static" ;;
    --services) MODE="services" ;;
    --all)      MODE="all" ;;
    --dry-run)  DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--static|--services|--all|--dry-run]"
      exit 0
      ;;
    *)
      warn "Unknown argument: $arg"
      ;;
  esac
done

# ── Preflight ──────────────────────────────────────────────────────────

[ -f "$SSH_KEY" ] || fail "SSH key not found: $SSH_KEY"
[ -d "$REPO_ROOT/orchestrator" ] || fail "Not in markco-services repo: $REPO_ROOT"

info "Deploying to ${HOST} (mode: ${MODE})"

if $DRY_RUN; then
  warn "DRY RUN — nothing will be changed"
fi

# ── File mappings ──────────────────────────────────────────────────────
#
# Each mapping: LOCAL_PATH:REMOTE_PATH
# Grouped by category for selective deploy.

# Static assets (served by Caddy, no restart needed)
STATIC_FILES=(
  "orchestrator/static/browser-shim.js:${REMOTE_STATIC}/browser-shim.js"
  "orchestrator/static/sandbox-bridge.js:${REMOTE_STATIC}/sandbox-bridge.js"
  "orchestrator/static/pyodide-runtime.js:${REMOTE_STATIC}/pyodide-runtime.js"
  "orchestrator/static/webr-runtime.js:${REMOTE_STATIC}/webr-runtime.js"
)

# Service source files (require restart)
SERVICE_FILES=(
  # Orchestrator
  "orchestrator/src/index.js:${REMOTE_SERVICES}/orchestrator/src/index.js"
  "orchestrator/src/caddy-config.js:${REMOTE_SERVICES}/orchestrator/src/caddy-config.js"
  "orchestrator/src/service-client.js:${REMOTE_SERVICES}/orchestrator/src/service-client.js"
  "orchestrator/src/user-lifecycle.js:${REMOTE_SERVICES}/orchestrator/src/user-lifecycle.js"
  "orchestrator/src/process-manager.js:${REMOTE_SERVICES}/orchestrator/src/process-manager.js"
  "orchestrator/src/runtime-lifecycle.js:${REMOTE_SERVICES}/orchestrator/src/runtime-lifecycle.js"
  "orchestrator/src/event-handler.js:${REMOTE_SERVICES}/orchestrator/src/event-handler.js"
  "orchestrator/src/caddy.js:${REMOTE_SERVICES}/orchestrator/src/caddy.js"
  "orchestrator/src/routes/main.js:${REMOTE_SERVICES}/orchestrator/src/routes/main.js"
  "orchestrator/src/routes/api.js:${REMOTE_SERVICES}/orchestrator/src/routes/api.js"
  # Auth service
  "auth-service/src/index.js:${REMOTE_SERVICES}/auth-service/src/index.js"
  "auth-service/src/db.js:${REMOTE_SERVICES}/auth-service/src/db.js"
  "auth-service/src/routes/auth.js:${REMOTE_SERVICES}/auth-service/src/routes/auth.js"
  "auth-service/src/routes/invites.js:${REMOTE_SERVICES}/auth-service/src/routes/invites.js"
  # Compute manager
  "compute-manager/src/index.js:${REMOTE_SERVICES}/compute-manager/src/index.js"
  "compute-manager/src/db.js:${REMOTE_SERVICES}/compute-manager/src/db.js"
  "compute-manager/src/ec2.js:${REMOTE_SERVICES}/compute-manager/src/ec2.js"
  "compute-manager/src/podman.js:${REMOTE_SERVICES}/compute-manager/src/podman.js"
  "compute-manager/src/migration.js:${REMOTE_SERVICES}/compute-manager/src/migration.js"
  "compute-manager/src/routes/runtimes.js:${REMOTE_SERVICES}/compute-manager/src/routes/runtimes.js"
  # Publish service
  "publish-service/src/index.js:${REMOTE_SERVICES}/publish-service/src/index.js"
  "publish-service/src/fsml.js:${REMOTE_SERVICES}/publish-service/src/fsml.js"
  "publish-service/src/html-shell.js:${REMOTE_SERVICES}/publish-service/src/html-shell.js"
  "publish-service/src/nav-tree.js:${REMOTE_SERVICES}/publish-service/src/nav-tree.js"
  "publish-service/src/routes/publish.js:${REMOTE_SERVICES}/publish-service/src/routes/publish.js"
  # Resource monitor
  "resource-monitor/src/index.js:${REMOTE_SERVICES}/resource-monitor/src/index.js"
  "resource-monitor/src/poller.js:${REMOTE_SERVICES}/resource-monitor/src/poller.js"
  "resource-monitor/src/events.js:${REMOTE_SERVICES}/resource-monitor/src/events.js"
  "resource-monitor/src/thresholds.js:${REMOTE_SERVICES}/resource-monitor/src/thresholds.js"
  "resource-monitor/src/code-analyzer.js:${REMOTE_SERVICES}/resource-monitor/src/code-analyzer.js"
  "resource-monitor/src/routes/monitor.js:${REMOTE_SERVICES}/resource-monitor/src/routes/monitor.js"
  # Caddyfile
  "orchestrator/Caddyfile:${REMOTE_CADDY}"
)

# ── Diff detection ─────────────────────────────────────────────────────

changed_static=()
changed_services=()

check_diff() {
  local local_file="$1"
  local remote_file="$2"

  [ -f "$REPO_ROOT/$local_file" ] || return 1

  local local_hash
  local_hash=$(md5sum "$REPO_ROOT/$local_file" | cut -d' ' -f1)

  local remote_hash
  remote_hash=$($SSH "$REMOTE" "md5sum '$remote_file' 2>/dev/null | cut -d' ' -f1" 2>/dev/null || echo "MISSING")

  [ "$local_hash" != "$remote_hash" ]
}

if [ "$MODE" = "auto" ] || [ "$MODE" = "all" ]; then
  info "Checking for changes..."

  for mapping in "${STATIC_FILES[@]}"; do
    local_file="${mapping%%:*}"
    remote_file="${mapping##*:}"
    if [ "$MODE" = "all" ] || check_diff "$local_file" "$remote_file"; then
      changed_static+=("$mapping")
    fi
  done

  for mapping in "${SERVICE_FILES[@]}"; do
    local_file="${mapping%%:*}"
    remote_file="${mapping##*:}"
    if [ -f "$REPO_ROOT/$local_file" ]; then
      if [ "$MODE" = "all" ] || check_diff "$local_file" "$remote_file"; then
        changed_services+=("$mapping")
      fi
    fi
  done

elif [ "$MODE" = "static" ]; then
  for mapping in "${STATIC_FILES[@]}"; do
    local_file="${mapping%%:*}"
    [ -f "$REPO_ROOT/$local_file" ] && changed_static+=("$mapping")
  done

elif [ "$MODE" = "services" ]; then
  for mapping in "${SERVICE_FILES[@]}"; do
    local_file="${mapping%%:*}"
    [ -f "$REPO_ROOT/$local_file" ] && changed_services+=("$mapping")
  done
fi

total=$(( ${#changed_static[@]} + ${#changed_services[@]} ))

if [ "$total" -eq 0 ]; then
  ok "Nothing to deploy — server is up to date"
  exit 0
fi

echo ""
if [ ${#changed_static[@]} -gt 0 ]; then
  info "Static files to deploy (${#changed_static[@]}):"
  for mapping in "${changed_static[@]}"; do
    echo "    $(basename "${mapping%%:*}")"
  done
fi

if [ ${#changed_services[@]} -gt 0 ]; then
  info "Service files to deploy (${#changed_services[@]}):"
  for mapping in "${changed_services[@]}"; do
    echo "    $(basename "${mapping%%:*}")"
  done
fi
echo ""

if $DRY_RUN; then
  warn "DRY RUN — would deploy $total files"
  [ ${#changed_services[@]} -gt 0 ] && warn "Would restart markco.service"
  exit 0
fi

# ── Deploy static files ───────────────────────────────────────────────

if [ ${#changed_static[@]} -gt 0 ]; then
  info "Deploying ${#changed_static[@]} static files..."
  for mapping in "${changed_static[@]}"; do
    local_file="${mapping%%:*}"
    remote_file="${mapping##*:}"
    $SCP "$REPO_ROOT/$local_file" "$REMOTE:/tmp/_deploy_$(basename "$local_file")" >/dev/null
    $SSH "$REMOTE" "sudo cp '/tmp/_deploy_$(basename "$local_file")' '$remote_file'" >/dev/null
  done
  ok "Static files deployed"
fi

# ── Deploy service files ──────────────────────────────────────────────

if [ ${#changed_services[@]} -gt 0 ]; then
  info "Deploying ${#changed_services[@]} service files..."
  for mapping in "${changed_services[@]}"; do
    local_file="${mapping%%:*}"
    remote_file="${mapping##*:}"
    $SCP "$REPO_ROOT/$local_file" "$REMOTE:/tmp/_deploy_$(basename "$local_file")" >/dev/null
    $SSH "$REMOTE" "sudo cp '/tmp/_deploy_$(basename "$local_file")' '$remote_file'" >/dev/null
  done
  ok "Service files deployed"

  info "Restarting markco.service..."
  $SSH "$REMOTE" "sudo systemctl restart markco" >/dev/null
  sleep 2

  status=$($SSH "$REMOTE" "sudo systemctl is-active markco" 2>/dev/null || echo "unknown")
  if [ "$status" = "active" ]; then
    ok "markco.service is active"
  else
    fail "markco.service is $status — check logs: sudo journalctl -u markco -n 20"
  fi
fi

# ── Smoke test ─────────────────────────────────────────────────────────

echo ""
info "Running smoke tests..."
PASS=0
TOTAL=0

smoke() {
  local name="$1"
  local url="$2"
  local expect="${3:-200}"
  TOTAL=$((TOTAL + 1))

  local code
  code=$(curl -sS --resolve "markco.dev:443:$HOST" -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [ "$code" = "$expect" ]; then
    PASS=$((PASS + 1))
    ok "$name → $code"
  else
    warn "$name → $code (expected $expect)"
  fi
}

smoke "login page"    "https://markco.dev/login"
smoke "sandbox"       "https://markco.dev/sandbox"
smoke "mrmd.iife.js"  "https://markco.dev/static/mrmd.iife.js"
smoke "browser-shim"  "https://markco.dev/static/browser-shim.js"
smoke "pyodide-rt"    "https://markco.dev/static/pyodide-runtime.js"
smoke "webr-rt"       "https://markco.dev/static/webr-runtime.js"

echo ""
if [ "$PASS" -eq "$TOTAL" ]; then
  ok "All $TOTAL smoke tests passed"
else
  warn "$PASS/$TOTAL smoke tests passed"
fi

# ── Summary ────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}Deploy complete${NC}: $total files deployed to markco.dev"
[ ${#changed_services[@]} -gt 0 ] && echo "  Service restarted: yes"
[ ${#changed_static[@]} -gt 0 ] && [ ${#changed_services[@]} -eq 0 ] && echo "  Service restarted: no (static only)"
