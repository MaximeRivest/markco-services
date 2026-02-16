#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
TOKEN="${TOKEN:-}"
USER_ID="${USER_ID:-}"
PUBLISH_PATH="${PUBLISH_PATH:-}"

info() { echo "[smoke] $*"; }
warn() { echo "[smoke][warn] $*"; }

curl_json() {
  local url="$1"
  local extra_header="${2:-}"
  if [[ -n "$extra_header" ]]; then
    curl -sS --fail --max-time 20 -H "$extra_header" "$url"
  else
    curl -sS --fail --max-time 20 "$url"
  fi
}

curl_page() {
  local url="$1"
  local extra_header="${2:-}"
  if [[ -n "$extra_header" ]]; then
    curl -sS --fail --max-time 20 -o /dev/null -H "$extra_header" "$url"
  else
    curl -sS --fail --max-time 20 -o /dev/null "$url"
  fi
}

info "BASE_URL=$BASE_URL"

info "Checking /api/health"
health_json="$(curl_json "$BASE_URL/api/health")"
echo "$health_json" | grep -q '"status"' || { echo "Health payload missing status"; exit 1; }

info "Checking /api/services"
services_json="$(curl_json "$BASE_URL/api/services")"
echo "$services_json" | grep -q '"services"' || { echo "Services payload missing services"; exit 1; }

if [[ -n "$TOKEN" ]]; then
  info "Checking authenticated /dashboard"
  curl_page "$BASE_URL/dashboard" "Authorization: Bearer $TOKEN"

  if [[ -n "$USER_ID" ]]; then
    info "Checking authenticated user path /u/$USER_ID/"
    curl_page "$BASE_URL/u/$USER_ID/" "Authorization: Bearer $TOKEN"
  else
    warn "TOKEN provided but USER_ID missing; skipping /u/<userId>/ check"
  fi

  # Optional WS sanity check if websocat is available
  if command -v websocat >/dev/null 2>&1; then
    ws_url="${BASE_URL/http:/ws:}"
    ws_url="${ws_url/https:/wss:}"
    info "Checking websocket /events with websocat"
    timeout 6 websocat -1 "$ws_url/events?token=$TOKEN" >/tmp/markco-smoke-ws.log 2>/dev/null || true
    if ! grep -q 'connected' /tmp/markco-smoke-ws.log 2>/dev/null; then
      warn "No explicit websocket welcome message observed (check manually if needed)"
    fi
  else
    warn "websocat not found; skipping websocket check"
  fi
else
  warn "TOKEN not provided; skipping authenticated dashboard/editor checks"
fi

if [[ -n "$PUBLISH_PATH" ]]; then
  info "Checking published path $PUBLISH_PATH"
  curl_page "$BASE_URL$PUBLISH_PATH"
fi

info "Smoke checks completed"
