# Implementation Blueprint: Electron → Cloud Sync → Phone Editing + Desktop-Backed Execution

Status: **Ready for implementation**  
Audience: **Implementing coding agent**  
Owner intent: **Make local Electron projects available on browser/phone, editable when desktop is offline, executable on desktop resources when online**

---

## 1) Product Goal (Non-negotiable)

Deliver this user experience:

1. User works locally in `mrmd-electron` on desktop.
2. Same project/documents are visible and editable from phone/browser (`markco.dev`) even if desktop app is closed/offline.
3. If desktop is online, code execution from phone/browser runs on desktop resources.
4. If desktop is offline, editing still works; execution either falls back to cloud runtime (default) or queues (optional mode).

---

## 2) Current-State Snapshot (from review)

### Working now
- markco.dev auth + dashboard + editor container lifecycle.
- Publish service (`/@user/project`) works in current legacy path.
- Per-project `mrmd-sync` inside editor path is functional in parts.
- Sandbox route is active.

### Not yet implemented / gaps
- No persistent shared sync relay service in production.
- `/join/<token>` and complete collaborator access flow are not wired end-to-end.
- No Electron sign-in + background cloud sync path for local projects.
- No device-agent runtime routing (phone → cloud → desktop runtime tunnel).
- Port conflict risk: docs/spec suggested sync relay on `3005`, but production `3005` is Umami.

### Reliability issues to address before feature expansion
- Historical websocket sync proxy hangups in logs.
- Runtime health/recovery churn observed.

---

## 3) Scope and Non-Scope

## In scope (V1 path)
- Single-user multi-device sync first.
- Markdown document sync (`.md`, `.qmd`) + file tree metadata.
- Desktop-backed execution routing for Python first.
- Cloud fallback runtime for execution continuity.

## Out of scope (for this implementation cycle)
- Full multi-user collaboration permissions model.
- Full asset/data sync (binary dedupe) beyond minimal placeholders.
- GPU-aware smart scheduling.
- Native mobile app (PWA/browser path is enough for now).

---

## 4) Architectural Guardrails

1. **Typing/open/switch must remain fast.**
   - Use phased rollout with feature flags.
   - Never block editor input on network.

2. **Durability before topology complexity.**
   - Cloud-persistent document state first.

3. **Desktop compute as optional accelerator, not dependency.**
   - Phone editing must work without desktop presence.

4. **Safe rollback at each phase.**
   - Prefer environment-flag rollback to code revert.

---

## 5) Implementation Phases

## Phase 0 — Stabilization (Required before new features)

### Objectives
- Eliminate known sync websocket instability and runtime flapping.
- Establish baseline metrics.

### Tasks
- Add/confirm metrics instrumentation:
  - `doc_open_ttfc_ms`
  - `doc_switch_ttfc_ms`
  - `doc_sync_rtt_ms`
  - `runtime_file_reflect_ms`
  - websocket error rate
  - runtime restart count
- Fix obvious websocket proxy failure paths in orchestrator + mrmd-server chain.
- Ensure runtime health checker does not thrash/restart healthy runtime containers.

### Acceptance
- 24h run without runaway ws error spam.
- runtime restarts are only on actual failures.

---

## Phase 1 — Persistent Cloud Sync Relay (Foundation)

### Critical decision
- **Do NOT use port 3005** (reserved for Umami in production).
- Use `SYNC_RELAY_PORT=3006` (default).

### Deliverables
1. New service: `markco-services/sync-relay`.
2. Persistent Yjs state store (Postgres table `documents`).
3. Authenticated websocket path for relay traffic.
4. Orchestrator routing to relay for sync path in cloud mode.
5. Feature flag rollout modes:
   - `SYNC_MODE=legacy`
   - `SYNC_MODE=mirror`
   - `SYNC_MODE=relay_primary`

### Suggested file/package targets
- `markco-services/sync-relay/*` (new)
- `markco-services/orchestrator/src/process-manager.js` (register service)
- `markco-services/orchestrator/src/index.js` (WS upgrade routing)
- `markco-services/orchestrator/src/service-client.js` (relay health client if needed)
- `mrmd-server/src/server.js` + `mrmd-server/src/sync-manager.js` (relay-aware mode)
- `mrmd-server/static/http-shim.js` (sync URL format compatibility)

### DB migration
Create table:
- `documents(user_id, project, doc_path, yjs_state BYTEA, content_text TEXT, content_hash, updated_at, created_at)`
- unique `(user_id, project, doc_path)`

### Acceptance
- Edit a doc in browser.
- Restart editor container.
- Reopen doc: no content loss.
- `documents` rows update as edits happen.
- Rollback to `SYNC_MODE=legacy` works instantly.

---

## Phase 2 — Electron Sign-in + Background Sync (Projects available on phone)

### Deliverables
1. Electron auth flow against markco.dev.
2. Secure token persistence on desktop.
3. Background document sync for local projects.
4. Project registration API so browser/phone can list synced projects.

### Suggested implementation shape
- In Electron:
  - Add “Sign in to MarkCo”.
  - Store session token securely.
  - Sync adapter: local file <-> Yjs relay doc.
  - Start with open/active docs; then expand to project scan.
- In platform:
  - Add project index/list endpoints (minimal single-user).

### Suggested file/package targets
- `mrmd-electron` sign-in UI + token store modules
- `mrmd-electron` project watcher/sync worker
- `markco-services/orchestrator` routes for project registry
- Optional helper updates in `mrmd-sync` if shared client abstraction is extracted

### Acceptance
- Open local project in Electron, sign in.
- Same project appears on markco.dev/phone.
- Desktop app closed/offline: phone can still open and edit previously synced docs.

---

## Phase 3 — Desktop Device Agent + Remote Execution Routing

### Deliverables
1. Desktop agent persistent WS to orchestrator.
2. Device registration + heartbeat.
3. Runtime registration events (Python first).
4. MRP request/response relay over existing outbound WS tunnel.
5. Execution routing logic with priority:
   - desktop session affinity
   - cloud runtime fallback

### Proposed transport contract
WS endpoint: `/api/agents/connect`

Message types:
- `REGISTER`
- `HEARTBEAT`
- `RUNTIME_UP`
- `RUNTIME_DOWN`
- `MRP_REQUEST`
- `MRP_RESPONSE`
- `DEVICE_LIST` (server → clients)

All messages must include:
- `request_id`/`message_id`
- `user_id`
- timestamp

### Suggested DB tables
- `devices`
- `device_capabilities` (or heartbeat snapshot table)
- `device_runtimes` (online runtime endpoints)

### Acceptance
- Desktop online with active Python runtime.
- Execute Python cell from phone/browser.
- Execution runs on desktop runtime and returns result successfully.
- UI shows execution origin (e.g., `ran_on: MacBook Pro`).

---

## Phase 4 — Desktop Offline Behavior + Cloud Fallback

### Deliverables
1. Offline detection from heartbeat timeout.
2. Scheduler fallback to cloud runtime automatically.
3. Optional mode: queue execution until desktop reconnects.

### Minimal policy
- Default: `fallback_to_cloud=true`.
- Optional setting: `fallback_to_cloud=false` (queue only).

### Acceptance
- Desktop goes offline.
- Phone/browser editing unaffected.
- Run request executes on cloud runtime if fallback enabled.

---

## 6) API Contracts to Implement (minimum)

## Sync
- `WS /sync/:userId/:project/:docPath`
- Auth required.

## Device agent
- `WS /api/agents/connect`
- Auth required.

## Projects
- `GET /api/projects` (current user)
- `GET /api/projects/:id/documents`
- `POST /api/projects/register-local` (from Electron sync worker)

## Runs
- `POST /api/runs` (accepts execution request, schedules route)
- `WS /api/runs/:id/events` (optional in V1 if existing output channel is sufficient)

---

## 7) Feature Flags & Rollback

Required flags:
- `SYNC_MODE=legacy|mirror|relay_primary`
- `ENABLE_DEVICE_AGENT=0|1`
- `ENABLE_REMOTE_EXEC_ROUTING=0|1`
- `ENABLE_CLOUD_FALLBACK=0|1`

Rollback policy:
- Any sync regression: set `SYNC_MODE=legacy`.
- Any routing regression: disable `ENABLE_REMOTE_EXEC_ROUTING`.
- Keep edits local and durable during rollback.

---

## 8) Security Requirements

1. WS auth for sync relay and agent connections.
2. Strict user scoping for docs, projects, runtime routing.
3. Do not expose local desktop ports publicly.
4. Agent uses outbound connection only (NAT-safe).
5. Short-lived tokens + server-side validation.

---

## 9) Observability Requirements

Add metrics/logs for:
- sync connection count / error rate
- sync persistence latency
- document open/switch p50/p95
- runtime routing decision and reason
- remote execution success/failure by target type (`device` vs `cloud`)
- device online/offline transitions

Include structured logs with fields:
- `user_id`, `device_id`, `project_id`, `doc_path`, `run_id`, `route_target`, `reason`

---

## 10) Test Plan (must pass before broad rollout)

## Functional
- cross-device edit convergence
- editor restart no data loss
- desktop-online execution routing
- desktop-offline cloud fallback

## Failure injection
- restart sync relay during active edits
- kill editor container during edits
- temporarily stop Postgres
- break desktop agent websocket

## Performance gates
- p95 open/switch <= baseline + 10% (no regression)
- sync RTT p95 < 120ms (cloud path)
- runtime file reflect p95 < 500ms

---

## 11) Recommended PR / Delivery Slices

1. **PR-1**: Phase 0 stabilization + metrics baseline.
2. **PR-2**: sync-relay service + DB migration + mirror mode.
3. **PR-3**: relay-primary for cloud editor path + rollback switches.
4. **PR-4**: Electron sign-in + token storage + active-doc sync.
5. **PR-5**: project listing/registry APIs + phone/browser visibility.
6. **PR-6**: device agent WS + registration + heartbeats.
7. **PR-7**: Python runtime routing over WS tunnel.
8. **PR-8**: offline detection + cloud fallback policy.

Each PR must include:
- migration notes
- test evidence
- rollback instructions

---

## 12) Implementation Notes for Agent

- Reuse existing Yjs and mrmd-sync protocol behavior; avoid inventing a new sync protocol.
- Keep editor typing path local-first and optimistic.
- Do not couple Phase 2 (document availability) to Phase 3 (remote execution).
- Assume production has Umami on `3005`; avoid port conflicts.
- Maintain backward compatibility with current `/u/:userId/*` routing while phasing in new paths.

---

## 13) Definition of Done (Program-Level)

Program is done when:
1. Local Electron project edits appear on phone/browser.
2. Phone/browser edits work while desktop is offline.
3. Phone/browser execution uses desktop runtime when desktop is online.
4. Cloud fallback executes when desktop is offline (if enabled).
5. No critical regression in editor interaction performance.
6. Rollback switches are verified in staging and production.

---

## 14) Quick Handoff Prompt (optional)

Use this when handing to an implementing coding agent:

> Implement `markco-services/docs/56-implementation-electron-phone-sync-and-device-runtime.md` in phase order. Start with Phase 0 and Phase 1 only. Keep changes feature-flagged and reversible. Prioritize reliability and no UX regressions over speed. Produce a short change log, acceptance test evidence, and rollback steps for each phase.
