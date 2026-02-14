# The Device Mesh: How Devices Find Each Other and Share Compute

> Written: 2026-02-14
> Status: Design exploration
> Prereq: [50-cross-device-vision.md](./50-cross-device-vision.md)

## The Goal

You install MRMD on three devices. You sign in on each. From that moment forward, you never think about sync or compute again. Documents are everywhere. Runtimes find each other. If your desktop has a GPU, your phone uses it. If your desktop sleeps, the cloud catches it before you notice. **Zero configuration, zero manual choices.**

## How It Feels

### First install (desktop)

```
Install MRMD → launch → "Sign in with GitHub" → done.
All your cloud projects appear in the sidebar.
Create a new notebook. Write some Python. Hit Run.
Python starts locally. Fast. Normal.

In the background (you don't see this):
  → MRMD opens a persistent connection to feuille.dev
  → Registers: "Maxime's MacBook Pro, Python 3.12, R 4.4, 
     Julia 1.11, RTX 4090, 32GB free"
  → Starts syncing document edits to cloud relay
```

### Second install (phone)

```
Install MRMD → open → "Sign in with GitHub" → done.
All your projects are there. Tap one.
The notebook loads instantly — content + outputs already synced.
Tap Run on a cell.

A subtle pill appears below the output:
  ⚡ Ran on MacBook Pro · 0.3s

Your desktop ran it. You didn't choose. It just happened.
```

### Desktop goes to sleep

```
You close your laptop lid. On your phone:

Nothing visible happens. No error. No spinner.

Behind the scenes:
  → Orchestrator notices MacBook's WebSocket dropped
  → Waits 30 seconds (maybe it's just a network blip)
  → MacBook doesn't reconnect
  → Orchestrator CRIU-snapshots the Python session to cloud storage
  → Session state preserved: loaded dataframes, trained models, everything

You tap Run on your phone:
  ☁️ Ran on cloud · 1.2s

Slightly slower. You might not even notice.
The output is the same — same session state, restored from snapshot.
```

### Desktop wakes up

```
You open your laptop the next morning.

MRMD reconnects to orchestrator.
  → Orchestrator: "Welcome back. I have your Python session 
     running on cloud. Want me to migrate it back to you?"
  → Migration happens automatically (CRIU checkpoint on cloud → 
     restore on desktop)
  → Takes ~2-3 seconds
  → Desktop now has the live session with all state

Next time you hit Run on your phone:
  ⚡ Ran on MacBook Pro · 0.3s

Back to local compute. Seamless.
```

### Third device (home laptop)

```
Install MRMD → sign in → projects appear.
Open the same notebook you were working on.
All content and outputs are there (Yjs sync).

Hit Run:
  → Orchestrator checks: MacBook Pro is online and has the session
  → Routes to MacBook Pro
  ⚡ Ran on MacBook Pro · 0.4s

Both the phone AND the home laptop use the desktop's runtime.
The desktop is just a compute node in your personal mesh.
```

## Architecture

### The Device Registry

Every MRMD installation maintains a persistent WebSocket to the cloud orchestrator. This is the heartbeat.

```
┌─────────────────────────────────────────────────────────┐
│                  Cloud Orchestrator                      │
│                                                         │
│  Device Registry:                                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ device_id  │ name           │ status │ runtimes   │  │
│  │ d-a829...  │ MacBook Pro    │ online │ py,r,julia │  │
│  │ d-f031...  │ Maxime's Phone │ online │ (none)     │  │
│  │ d-7c44...  │ Home Laptop    │ online │ py,bash    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Session Registry:                                      │
│  ┌───────────────────────────────────────────────────┐  │
│  │ session    │ project     │ device      │ state    │  │
│  │ python-01  │ analysis    │ MacBook Pro │ running  │  │
│  │ python-01  │ analysis    │ cloud       │ snapshot │  │
│  │ r-01       │ stats-proj  │ MacBook Pro │ running  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Routing Rules:                                         │
│  1. Session affinity (prefer device that has the state) │
│  2. Hardware match (GPU request → device with GPU)      │
│  3. Network proximity (same LAN → prefer direct)       │
│  4. Fallback to cloud                                   │
└─────────────────────────────────────────────────────────┘
        ↕ WS            ↕ WS              ↕ WS
   ┌─────────┐    ┌──────────┐     ┌──────────────┐
   │ Desktop  │    │  Phone   │     │ Home Laptop  │
   │ py,r,jul │    │ (thin)   │     │ py,bash      │
   └─────────┘    └──────────┘     └──────────────┘
```

### What the WebSocket carries

The persistent WS between each device and the orchestrator is a multiplexed channel:

```
→ Device to Cloud:
  REGISTER    { device_id, name, os, hardware, runtimes[] }
  HEARTBEAT   { device_id, cpu%, mem%, gpu% }  (every 30s)
  RUNTIME_UP  { runtime_type, port, session_id, project }
  RUNTIME_DOWN { session_id }
  SYNC        { yjs update binary }  (document edits)

← Cloud to Device:
  MRP_REQUEST  { session_id, request }  (execute code on this device)
  MRP_RESPONSE { session_id, response }  (result from another device)
  SYNC         { yjs update binary }
  MIGRATE_OUT  { session_id, target }  (CRIU checkpoint, send state)
  MIGRATE_IN   { session_id, snapshot }  (receive state, CRIU restore)
  DEVICE_LIST  { devices[] }  (for UI: "connected devices" indicator)
```

This is one WebSocket per device doing everything. Document sync, compute routing, device management — all multiplexed.

### How compute routing works

When any client (desktop, phone, browser) hits Run on a cell:

```
1. Client sends execution request
     ↓
2. Smart Router (local on desktop, or cloud for phone/browser) decides:
     │
     ├─ Is there a LOCAL runtime for this session?
     │   → Execute locally. Done. (0ms routing overhead)
     │
     ├─ Is another device online with this session RUNNING?
     │   → Tunnel MRP request through cloud WebSocket relay
     │   → ~100-200ms added latency (fine for cell execution)
     │
     ├─ Is there a CRIU snapshot of this session?
     │   → Restore on best available target (cloud or a device)
     │   → ~1-3 second restore, then execute
     │   → Subsequent runs are fast (session is now live)
     │
     └─ Nothing exists?
         → Cold start a runtime
         → Cloud: ~2-5 seconds
         → Local: ~1-2 seconds
         → Subsequent runs are fast
```

**The critical design choice:** the desktop MRMD app has its own smart router that tries local first, then falls back to cloud. This means when you're working on your desktop with no internet, everything works normally. The cloud is an accelerator, not a dependency.

```
Desktop Smart Router:
  1. Local runtime? → use it (offline-capable)
  2. Online? → register runtime with cloud (others can use it)
  3. Need a runtime I don't have? → ask cloud to route

Phone (always goes through cloud):
  1. Send to orchestrator
  2. Orchestrator routes to best target
```

### The relay tunnel (how phone talks to your desktop)

The biggest technical question: your desktop is behind a NAT/firewall. Your phone is on LTE. How does an MRP request get from phone to desktop?

**Answer: the existing WebSocket is the tunnel.**

```
Phone                    Cloud Orchestrator              Desktop
  │                            │                            │
  │  MRP execute request       │                            │
  │ ─────────────────────────→ │                            │
  │                            │  Route: desktop has        │
  │                            │  this session running      │
  │                            │                            │
  │                            │  MRP request (over WS)     │
  │                            │ ──────────────────────────→│
  │                            │                            │
  │                            │         (Python runs)      │
  │                            │                            │
  │                            │  MRP response (over WS)    │
  │                            │ ←──────────────────────────│
  │                            │                            │
  │  MRP response              │                            │
  │ ←───────────────────────── │                            │
```

No port forwarding. No VPN. No Tailscale. The desktop already has an outbound WebSocket open to the cloud. The cloud just sends messages down it. Works behind any NAT, any firewall, any corporate network.

**Latency budget:**
- Phone → cloud: ~30-50ms (LTE)
- Cloud → desktop: ~20-40ms (home broadband)
- Python execution: variable
- Round trip overhead: ~100-150ms
- Totally fine. Cell execution typically takes 200ms-30s anyway.

**For streaming outputs** (print statements, progress bars, plots appearing):
- Same tunnel, streamed back as they arrive
- Phone sees output appearing in real-time
- Same as if it were running locally, just with slight network delay

### Document sync in detail

Every device runs a Yjs client. The cloud relay is the hub:

```
Desktop edits a cell
  → Yjs generates an update (binary, ~50-500 bytes typically)
  → Sent over the persistent WebSocket to cloud relay
  → Cloud relay:
      1. Persists to storage (the document is now saved)
      2. Broadcasts to all other connected devices
  → Phone receives update
  → Phone's local Yjs applies it
  → UI updates (you see the edit appear)
  
Latency: typically 50-150ms end-to-end.
For typing, this feels "live" — like Google Docs.
```

**Offline behavior:**
- You edit on the plane (no internet)
- Yjs queues updates locally
- You land, phone reconnects
- Queued updates sync to cloud relay
- CRDT merge: no conflicts, ever, by mathematical guarantee
- Other devices see your changes appear

**What gets synced:**
- Document content (markdown + code cells): Yjs CRDT
- Cell outputs (text, images, plots): Yjs CRDT (attached to cell)
- File tree (which files exist): Yjs Map
- Cursor position: Yjs Awareness (ephemeral, not persisted)

**What does NOT sync (by design):**
- `.venv`, `node_modules`, `__pycache__` — recreated locally
- Runtime state (variables, loaded data) — that's CRIU's job
- Temp files, build artifacts

### Asset sync

Images, data files, plots — these are bigger than text and need different handling:

```
You drag an image into a notebook on your desktop.
  → MRMD hashes the file (SHA-256)
  → Uploads to cloud storage (S3/R2) by hash
  → Yjs document references it: ![plot](asset://sha256-a1b2c3...)
  → Phone receives the Yjs update
  → Phone sees the image reference
  → Lazy-loads: fetches sha256-a1b2c3 from cloud storage
  → Image appears

Same image used in another notebook?
  → Same hash. Already in cloud storage. Zero upload.
```

**Content-addressable storage** means:
- Deduplication is free
- Upload once, reference everywhere
- Phone can show a placeholder until the image loads
- Offline: shows cached version or placeholder

## The Compute Indicator

The user should have a **subtle but always-visible** sense of their compute topology. Not intrusive — think Wi-Fi signal bars, not a dashboard.

### In the editor (titlebar or status bar)

```
Normal (local):        ⚡ MacBook Pro
Remote (via desktop):  ⚡ MacBook Pro (remote)
Cloud:                 ☁️ Cloud
No runtime:            ○ No runtime
Restoring:             ↻ Restoring session...
```

### Per-cell (after execution, subtle)

```
Output appears, then a faint label:
  ⚡ MacBook Pro · 0.3s

Or:
  ☁️ cloud · 1.2s
```

### Device list (in account dropdown)

```
┌─────────────────────────┐
│  Maxime Rivest          │
│  maxime@email.com       │
│  ────────────────────── │
│  Devices                │
│  ● MacBook Pro    ⚡    │  ← online, has runtimes
│  ● iPhone          📱   │  ← online, this device
│  ○ Home Laptop          │  ← offline
│  ────────────────────── │
│  Dashboard              │
│  Sign out               │
│  ────────────────────── │
│  Runtime: MacBook Pro ▾ │  ← tap to override
└─────────────────────────┘
```

The "Runtime" selector at the bottom lets power users override the automatic routing. Most users never touch it.

## Session Continuity Scenarios

### Scenario: "I started training and left"

```
Desktop: model.fit(X, y, epochs=100)  → training starts
You leave. Close laptop lid.

  → Orchestrator detects desktop offline (WS drops)
  → PROBLEM: training is mid-execution
  → Option A: CRIU checkpoint mid-training (if possible)
    → Restore on cloud → training resumes from exact instruction
  → Option B: Training was in a Python process that dies
    → Orchestrator knows it was running, marks it as "interrupted"
    → When you reconnect, shows: "Training was interrupted. Re-run?"
  → Option C: (future) Training runs in cloud from the start
    → Desktop closing doesn't matter — it was always on cloud
    → You just see results appear on any device

For long-running work, Option C is the right default.
Smart router should detect: "this cell will run for >30s" and 
prefer cloud or always-on device.
```

### Scenario: "Same notebook on two desktops"

```
Office desktop has Python session with loaded data.
Home laptop opens same notebook, hits Run.

  → Orchestrator routes to office desktop (has the session)
  → Home laptop sees output appear
  → Both devices show the same document (Yjs sync)
  → Both devices can run cells (both route to same runtime)
  → It's like a thin client — the runtime is shared

What if you want SEPARATE sessions?
  → "Fork runtime" option in the UI
  → Creates an independent Python session on your local machine
  → Your home laptop now has its own state
  → Document still syncs, but execution is local
```

### Scenario: "Offline on a plane"

```
Desktop, no internet:
  → All local runtimes work (Python, R, Julia, Bash, JS)
  → Document edits are local, queued for sync
  → New outputs are local, queued for sync
  → MRMD works exactly like a normal desktop app
  → Status bar: "Offline — changes will sync when connected"

Phone, no internet:
  → Can read all cached documents and outputs
  → Can edit text (queued for sync)
  → Cannot run code (no local runtimes, no cloud)
  → Run button shows: "Offline — will run when connected"
  → OR: queue the execution, run it when back online
```

## Implementation Phases

### Phase 1: The Heartbeat (weeks)
- Desktop Electron opens persistent WS to orchestrator on sign-in
- Registers device name, OS, available runtimes
- Heartbeat every 30s
- Orchestrator stores device registry in Postgres
- Account dropdown shows "Your Devices" list
- **Value: user sees their devices are connected. Trust begins.**

### Phase 2: Document Sync (weeks)  
- Cloud Yjs relay with persistent storage
- Electron syncs open documents through cloud relay
- Phone PWA connects to same relay
- Offline edits queue and merge on reconnect
- **Value: "I never lose my work." The most important moment.**

### Phase 3: Remote Execution (months)
- Phone sends MRP request to orchestrator
- Orchestrator relays to desktop's runtime over WS tunnel
- Output flows back to phone
- Per-cell "ran on" indicator
- **Value: phone becomes useful for real work. Wow moment.**

### Phase 4: Automatic Failover (months)
- Desktop goes offline → orchestrator detects in 30s
- CRIU snapshot saved to cloud
- Next execution request restores on cloud automatically
- Desktop comes back → migrate session back
- **Value: "it just works, no matter what." Trust is complete.**

### Phase 5: Smart Routing (later)
- Hardware-aware routing (GPU cells → GPU device)
- Long-running detection (>30s → prefer cloud)
- Cost optimization (use your own hardware when available)
- Multi-user (share runtime with collaborator)
- **Value: MRMD is smarter than you about where to run things.**
