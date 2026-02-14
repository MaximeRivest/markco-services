# Engineering Roadmap: From Cloud Editor to Device Mesh

> Written: 2026-02-14
> Prerequisites: [50-cross-device-vision.md](./50-cross-device-vision.md), [51-device-mesh-design.md](./51-device-mesh-design.md)
> 
> This is the practical engineering plan. Each step is scoped, has concrete deliverables, and unlocks the next step.

## Where We Are Today

Working:
- Cloud editor on EC2 (one user, editor + runtime containers)
- GitHub OAuth login
- Yjs CRDT sync within a single editor session (file-backed, per-container)
- CRIU checkpoint/restore/migrate of runtime containers
- Multiple runtimes: Python, R, Julia, Bash, JS
- Publishing at `/@user/project`

Not working yet:
- Data persistence across container restarts (fix in progress)
- Account UI in editor (fix in progress)
- No cross-device anything — Yjs sync is local to each container

## The Key Insight

Everything builds on one thing: **a persistent Yjs relay in the cloud that outlives containers.** Right now mrmd-sync runs inside each editor container and writes to the container's filesystem. When the container dies, the sync state dies. If we pull that out into a persistent cloud service, we get:

1. Documents survive container restarts (backup)
2. Multiple devices can connect to the same document (sync)
3. Phone can read/edit without a container running (thin client)
4. Desktop Electron can sync in the background (offline-first)

Everything else in the vision — runtime routing, device mesh, session handoff — is built on top of this foundation.

---

## Step 1: Persistent Cloud Sync Relay

**What:** A long-lived mrmd-sync instance that runs as a markco-services service (like auth-service or compute-manager), stores Yjs state in Postgres or S3, and accepts WebSocket connections from any authenticated client.

**Why first:** This is the foundation for every cross-device feature. Without it, each device is an island.

**What exists:** mrmd-sync already does everything we need except:
- It runs per-container (not shared)
- It persists to the local filesystem (not cloud storage)
- It has no auth (relies on being inside the container)

**What to build:**

1. **Sync relay service** (`markco-services/sync-relay/`)
   - Runs on port 3005 alongside the other services
   - Wraps mrmd-sync with a persistent storage backend
   - Documents keyed by `userId/projectName/docPath`
   - Yjs state stored in Postgres (binary column) or S3
   - WebSocket endpoint: `wss://markco.dev/sync/:userId/:project/:doc`

2. **Auth on the WebSocket**
   - Client sends session token on WS connect (query param or first message)
   - Relay validates against auth-service
   - Rejects unauthorized connections

3. **Storage backend for mrmd-sync**
   - New option: `storage: 'postgres'` (alongside existing file-based)
   - On document update → debounced write to Postgres (Yjs snapshot binary)
   - On document open → load from Postgres if exists
   - This could be a contribution back to the mrmd-sync open-source package

**What it unlocks:**
- Documents survive container restarts
- Foundation for multi-device sync
- Browser editor can work without an editor container (reading/editing only, no execution)

**Rough scope:** 1-2 weeks

---

## Step 2: Editor Containers Connect to Cloud Relay

**What:** Instead of each editor container running its own mrmd-sync, it connects to the cloud sync relay. The editor container becomes a client of the relay, not a host.

**Why next:** This makes the cloud editor resilient. Restart a container, kill it, migrate it — the document state is safe in the relay.

**What to change:**

1. **mrmd-server cloud mode**
   - When `CLOUD_MODE=1`, don't spawn a local mrmd-sync process
   - Instead, proxy sync WebSocket connections to the cloud relay
   - The relay URL comes from an env var: `SYNC_RELAY_URL=ws://localhost:3005`

2. **http-shim.js update**
   - In cloud mode, sync WebSocket connections already go through the orchestrator
   - Orchestrator routes `/sync/*` to the cloud relay instead of to the editor container
   - Editor container no longer needs to run mrmd-sync at all

3. **Orchestrator WebSocket routing**
   - `/u/:userId/sync/:project/:doc` → cloud relay (not editor container)
   - Auth is already handled (cookie validated by orchestrator)

**What it unlocks:**
- Container restarts don't lose document state
- Multiple browser tabs/devices can edit the same document through the relay
- Editor containers become stateless (easier to replace/scale)

**Rough scope:** 1 week

---

## Step 3: Desktop Electron Sign-In + Background Sync

**What:** Add a "Sign in to MarkCo" option in the Electron app. Once signed in, documents sync to the cloud relay in the background.

**Why next:** This is the "never lose work" moment. Users get cloud backup and the ability to see their files from any device.

**What to build:**

1. **Sign-in flow in Electron**
   - Settings or menu: "Sign in to MarkCo"
   - Opens browser to `markco.dev/auth/electron` → GitHub OAuth → callback with token
   - Electron stores the session token securely (electron-store or OS keychain)
   - Shows signed-in state in the UI (avatar, like the cloud account UI)

2. **Background sync in Electron**
   - On sign-in, open a persistent WebSocket to `wss://markco.dev/sync/...`
   - For each open document, connect to the relay
   - Local edits → Yjs update → relay → persisted
   - Relay updates → Yjs update → local file save
   - This is bidirectional: cloud changes appear locally, local changes push to cloud

3. **Project registry**
   - When signed in, Electron registers its open projects with the orchestrator
   - `POST /api/devices/register` → `{ device_id, name, os, projects[] }`
   - This is the seed of the device registry from the mesh design

4. **Sync indicator in the UI**
   - Status bar: "Synced ✓" / "Syncing..." / "Offline (changes saved locally)"
   - Subtle, like Obsidian's sync status

**What it unlocks:**
- Desktop users get automatic cloud backup
- Documents are available from any device
- Foundation for device registry

**What it does NOT do yet:**
- No remote execution (that's Step 5)
- No file/asset sync (just document content via Yjs)
- Phone can't see documents yet (that's Step 4)

**Rough scope:** 2-3 weeks

---

## Step 4: Phone PWA

**What:** A mobile-optimized web app at `markco.dev/m/` for reading, light editing, and running code.

**Why next:** Validates cross-device without building a native app. Uses everything from Steps 1-3.

**What to build:**

1. **Mobile web UI** (`markco-services/mobile/` or separate repo)
   - Responsive, touch-friendly
   - Document list (from user's synced projects)
   - Document viewer (rendered markdown + outputs)
   - Light editor (markdown prose editing, tweak code values)
   - Run button on code cells

2. **Connects to cloud sync relay**
   - Same Yjs WebSocket connection as desktop
   - Edits from phone appear on desktop and vice versa
   - Outputs synced via Yjs (attached to cells)

3. **Execution routing**
   - Phone has no local runtimes
   - "Run" sends MRP request to orchestrator
   - Orchestrator routes to user's cloud runtime container
   - If no container running, starts one (or restores from CRIU snapshot)
   - Output streams back to phone via WebSocket

4. **Optimizations for mobile**
   - Don't load the full CodeMirror editor (too heavy)
   - Use a lightweight markdown renderer + simple textarea for edits
   - Lazy-load images/assets
   - Service worker for offline reading of cached documents

**What it unlocks:**
- Cross-device experience is real: edit on desktop, read/tweak/run on phone
- Validates the full sync + execution pipeline
- Proves the architecture before investing in native apps

**Rough scope:** 3-4 weeks

---

## Step 5: Desktop Runtime Registration + Remote Execution

**What:** Desktop Electron registers its running runtimes with the cloud orchestrator. Other devices (phone, other computers) can execute code on the desktop's runtimes through the cloud.

**Why next:** This is the "wow" moment — phone uses desktop's GPU. And it saves cloud compute costs.

**What to build:**

1. **Persistent WebSocket from Electron to orchestrator**
   - Already started in Step 3 (device registration)
   - Extend to multiplex: sync + device heartbeat + MRP relay
   - Heartbeat every 30s: `{ cpu%, mem%, gpu_name, runtimes[] }`

2. **Runtime registration**
   - When Electron starts a Python/R/Julia session, register with orchestrator
   - `RUNTIME_UP { runtime_type: "python", session_id, project, port }`
   - Orchestrator stores in device registry

3. **MRP relay through WebSocket**
   - Phone sends execution request to orchestrator
   - Orchestrator identifies: desktop has this session running
   - Sends MRP request down the desktop's WebSocket
   - Desktop's mrmd-server receives it, forwards to local runtime
   - Response flows back: runtime → mrmd-server → WebSocket → orchestrator → phone
   - New message types on the WS: `MRP_REQUEST`, `MRP_RESPONSE`

4. **Routing logic in orchestrator**
   - Priority: user's desktop (online, has session) → cloud container → cold start
   - Per-cell indicator returned with response: `{ ran_on: "MacBook Pro", duration_ms: 340 }`

5. **"Ran on" indicator in UI**
   - Phone and desktop show where each cell executed
   - Subtle pill below output: "⚡ MacBook Pro · 0.3s" or "☁️ cloud · 1.2s"

**What it unlocks:**
- Phone runs code on your desktop — the signature feature
- Other computers can use your desktop's runtimes too
- Cloud compute is only used when desktop is offline
- Foundation for automatic failover (Step 6)

**Rough scope:** 3-4 weeks

---

## Step 6: Automatic Failover with CRIU

**What:** When a device goes offline, the orchestrator automatically snapshots running sessions and restores them elsewhere. When the device comes back, sessions migrate home.

**Why next:** This makes the remote execution from Step 5 reliable. Without it, desktop going offline = broken experience.

**What to build:**

1. **Offline detection**
   - WebSocket heartbeat timeout (30s no heartbeat → mark device as suspect)
   - 60s no reconnect → mark device as offline
   - Orchestrator emits `DEVICE_OFFLINE` event

2. **Automatic snapshot on device offline**
   - If device had running runtimes, CRIU snapshot them to cloud storage (S3)
   - This is already proven (compute-manager has snapshot/restore)
   - New: trigger it automatically on device disconnect, not just manually

3. **Transparent restore on next execution**
   - Phone hits Run → orchestrator checks routing → desktop is offline
   - Orchestrator restores the CRIU snapshot on a cloud EC2
   - Runtime resumes with full session state
   - Phone sees the result (slightly slower — restore takes ~1-3s)
   - Next requests are fast (runtime is now live on cloud)

4. **Migration back on reconnect**
   - Desktop comes back online → orchestrator detects via WebSocket reconnect
   - Orchestrator migrates runtime from cloud back to desktop (CRIU checkpoint → restore)
   - Notify all connected clients of new routing

5. **Edge cases**
   - Desktop goes offline mid-execution → execution fails, client retries against cloud
   - Snapshot too old → discard, cold start instead
   - Desktop and cloud both have a session → prefer desktop, checkpoint cloud copy

**What it unlocks:**
- The experience is now seamless: desktop online or offline, execution just works
- Users build trust: "it always works, I don't think about it"
- Foundation for smart routing (GPU-aware, cost-aware)

**Rough scope:** 2-3 weeks (CRIU infra already exists, mainly orchestration logic)

---

## Step 7: Smart Routing + Polish

**What:** Hardware-aware routing, long-running task detection, cost optimization, and UX polish.

**Things to build (in any order):**

1. **GPU-aware routing**
   - Device registration includes GPU info
   - Cells that import torch/tensorflow/jax → prefer GPU device
   - Could use static analysis or just track which sessions use GPU

2. **Long-running detection**
   - If a cell has run for >30s before, mark it as "long-running"
   - Prefer cloud or always-on device for long-running cells
   - "This will take a while — running on cloud so you can close your laptop"

3. **Device list UI**
   - In account dropdown: show connected devices
   - Status indicators: online/offline, runtimes available
   - Optional: "Run on..." picker to override automatic routing

4. **Asset sync**
   - Content-addressable storage for images and data files
   - Hash → S3 upload, reference in Yjs document
   - Lazy loading on phone/other devices

5. **File tree sync**
   - Project structure as a Yjs Map
   - New file on desktop → appears on phone
   - Delete on phone → deletes on desktop
   - This completes the "full project sync" beyond just document content

6. **Native phone app (Capacitor)**
   - Wrap the PWA from Step 4
   - Add: push notifications ("Training finished"), offline cache, app icon
   - Use the same codebase, minimal native code

**Rough scope:** Ongoing, each sub-item is 1-2 weeks

---

## Dependency Graph

```
Step 1: Cloud Sync Relay
  │
  ├──→ Step 2: Editor Containers Use Relay
  │      │
  │      └──→ Step 3: Desktop Sign-In + Sync
  │             │
  │             ├──→ Step 4: Phone PWA
  │             │      │
  │             │      └──→ Step 6: Auto Failover (needs phone to test)
  │             │
  │             └──→ Step 5: Desktop Runtime Registration
  │                    │
  │                    └──→ Step 6: Auto Failover
  │                           │
  │                           └──→ Step 7: Smart Routing + Polish
  │
  └──→ Step 4 can also start in parallel with Step 3
       (phone can connect to relay even without desktop sync)
```

## Timeline Estimate

| Step | Scope | Cumulative |
|------|-------|------------|
| Step 1: Cloud Sync Relay | 1-2 weeks | 2 weeks |
| Step 2: Editor Uses Relay | 1 week | 3 weeks |
| Step 3: Desktop Sync | 2-3 weeks | 6 weeks |
| Step 4: Phone PWA | 3-4 weeks | 10 weeks |
| Step 5: Runtime Routing | 3-4 weeks | 14 weeks |
| Step 6: Auto Failover | 2-3 weeks | 17 weeks |
| Step 7: Polish | Ongoing | — |

~4 months to the "phone uses desktop's GPU" moment. ~2 months to "I never lose my work."

These are solo-developer-with-AI-tools estimates, nights-and-weekends pace. Could be faster with focused sprints.

## What NOT to Build

- **Don't build a native phone app yet.** PWA first. Validate the UX before investing in native.
- **Don't sync .venv/node_modules.** Recreate from lockfiles. CRIU handles runtime state.
- **Don't build real-time collaboration yet.** Single-user multi-device is enough. Collab is a separate feature that uses the same Yjs relay but adds presence, cursors, permissions.
- **Don't optimize sync performance yet.** Get it working, then optimize. Yjs updates are tiny (50-500 bytes typically). Postgres can handle it.
- **Don't build a custom sync protocol.** Yjs + WebSocket is battle-tested. The relay is just a Yjs provider with persistent storage.
