# Cross-Device Vision: MRMD Everywhere

> Written: 2026-02-14
> Status: Design exploration — not committed to any timeline

## The Promise

You open MRMD on your laptop and work on a data analysis. You leave for lunch. On the bus, you pull out your phone, open the same notebook, tweak a parameter, hit Run — it executes on your laptop's GPU back at the office. You see the result on your phone over LTE. That evening on your home laptop, you open MRMD and everything is there: your documents, your outputs, your running Python session with all its loaded dataframes. You never thought about syncing. You never lost anything.

## Why Our Architecture Already Points Here

Most of this isn't fantasy — it falls out of decisions we've already made:

- **Yjs CRDTs** — documents sync conflict-free across any number of clients. Works offline, merges automatically on reconnect. This is the exact right foundation.
- **MRP protocol** — runtimes are just HTTP endpoints. The client doesn't know or care if Python is running locally, in a container on EC2, or on your other computer across the internet.
- **http-shim.js** — the browser already doesn't talk to runtimes directly. It goes through a proxy layer. That proxy can point anywhere.
- **CRIU snapshots** — a running Python session (with all its in-memory state) can be frozen to disk and woken up somewhere else.
- **Cloud orchestrator** — already tracks which user has which runtimes running where.

## The Layers

### Layer 1: Document Sync (closest to ready)

```
Phone  ──┐
          ├──→  Cloud Yjs Relay  ←──→  Persistent Storage (S3/Postgres)
Desktop ──┘
```

Every device connects to the same Yjs document through a cloud relay. Edits on your phone appear on your desktop instantly. Edits on your desktop while your phone is offline merge cleanly when it reconnects. No conflicts, no "which version do you want to keep?"

`mrmd-sync` already does this for browser↔server. The step is making the cloud relay the **permanent source of truth** rather than the filesystem, and having every client (Electron, phone, browser) connect to it.

**What we'd build:**
- Persistent Yjs storage backend (Postgres or S3-backed)
- Always-on cloud relay (not per-container, shared service)
- Electron connects to cloud relay on startup (background, non-blocking)
- Offline-first: local edits work instantly, sync when online

### Layer 2: File & Asset Sync

Documents are easy (CRDTs). The filesystem is harder. Think in tiers:

| What | How | Sync strategy |
|------|-----|---------------|
| Document content | Yjs CRDT | Real-time, conflict-free |
| Project structure (file tree) | Yjs Map | Real-time, all clients see same tree |
| Small assets (images <5MB) | Content-addressed (hash → S3/R2) | Upload once, reference by hash |
| Large assets (datasets, models) | Content-addressed + lazy download | Phone only pulls what it needs to render |
| Environments (.venv, node_modules) | Never sync | Recreate from lockfiles, or CRIU restore |

**Key insight: don't sync the filesystem. Sync the project state.** The filesystem is a local materialization of that state. Each device materializes what it needs. Your phone doesn't need the .venv — it runs code on the cloud or your desktop.

### Layer 3: Runtime Routing (the magic one)

This is where our architecture really shines:

```
Phone hits "Run" on a Python cell
  → MRP request goes to cloud orchestrator
  → Orchestrator checks: where is this user's Python runtime?
     Priority:
       1. User's desktop is online and has a running session → route there
       2. Cloud runtime exists (maybe CRIU-sleeping) → wake it, route there
       3. Nothing exists → cold start a cloud runtime
  → MRP response flows back to phone
  → Yjs syncs the output to all devices
```

**Your desktop becomes your own personal compute node.** The phone never needs to know where the runtime physically is. The orchestrator is just a smart router.

**How the desktop registers itself:**

```
Desktop MRMD starts
  → starts local Python, R, Julia, Bash as usual
  → opens persistent WebSocket to cloud orchestrator
  → registers: "I'm user X, I have Python on :8000, R on :8001,
     GPU: RTX 4090, 32GB RAM free"
  → orchestrator stores this as available runtime endpoints
  → when phone needs a runtime, orchestrator tunnels MRP 
    through this WebSocket (or via a relay)
```

**Tunneling options:**
- WebSocket tunnel (orchestrator relays MRP over the existing WS connection — works behind NAT)
- Tailscale/WireGuard mesh (direct device-to-device, lower latency, harder setup)
- Cloud relay with TURN-style fallback (like WebRTC — try direct, fall back to relay)

The WebSocket tunnel is simplest and works everywhere. Latency adds maybe 50-100ms per cell execution which is fine for most workloads.

### Layer 4: "Your Runtime Follows You" (CRIU makes this transcendent)

**Monday morning, desktop at office:**
- Work on data analysis, build up rich Python state (loaded dataframes, trained models)

**Monday lunch, phone on the bus:**
- See the same notebook with all outputs rendered
- Hit Run on a new cell → routes to desktop at the office
- See results on phone

**Monday evening, laptop at home:**
- Desktop at office went to sleep
- Orchestrator CRIU-checkpointed the Python session automatically
- Open MRMD on home laptop → orchestrator restores the checkpoint on cloud compute
- **Entire Python session state is there** — the dataframes, the models, everything
- Continue exactly where you left off

**Tuesday morning, back at desktop:**
- Orchestrator migrates runtime back to desktop (faster, free compute)
- Seamless. You never thought about it.

### Layer 5: Phone App

Don't make a full code editor on a phone. Touch keyboards and code don't mix. Instead, play to the phone's strengths:

**Primary: Reading**
- Beautifully rendered markdown + outputs
- Scroll through notebooks like reading a paper
- Pinch to zoom on plots and figures

**Secondary: Light editing**
- Edit markdown prose (this IS comfortable on a phone)
- Tweak values in code cells (change `epochs=10` to `epochs=50`)
- Add annotations and comments

**Tertiary: Execution & monitoring**
- Tap to run any cell
- See outputs streaming in real-time
- Kill long-running cells
- Push notifications: "Training finished", "Out of memory"

**Not a priority: Heavy code writing**
- That's what your desktop is for
- Phone is for reading, reviewing, tweaking, monitoring

**Implementation path:** Start as a PWA at `feuille.dev/m/` (not a native app). Validates the UX with zero App Store friction. Wrap in Capacitor later for push notifications and offline.

## Delightful Experiences That Fall Out of This

### "Borrow a runtime"
You're on your phone, need to run something heavy. Your desktop is on at home. MRMD routes execution there automatically. If desktop is off, falls back to cloud. You never choose — it just picks the best option.

### "Session handoff"
Like Apple Handoff but for compute. Phone shows a subtle banner: "Continue on MacBook?" Tap it, MacBook opens with the document at exactly where you were scrolling on your phone.

### "Always-on notebooks"
A notebook can be "deployed" — runs on a schedule. Check it on your phone, latest outputs are there. A live dashboard that's also an editable notebook.

### "Share a runtime"
You and a colleague both have the same document open (CRDT collab). You share your running Python session. They see your variables, run cells against your state. Pair programming on notebooks with zero setup.

### "Run on..."
Right-click a cell → "Run on phone" (test mobile rendering), "Run on cloud GPU" (ML training), "Run on my desktop" (free compute, local data). The runtime is a choice, not a constraint.

## Build Order

| Phase | What | Why first |
|-------|------|-----------|
| **Now** | Data persistence, account UI, basic cloud editor | Foundation — nothing works without this |
| **Next** | Cloud Yjs relay with persistent storage | Gives you cloud backup for free. Documents survive container restarts. |
| **Then** | Electron ↔ cloud sync | Desktop app connects to cloud relay on startup. Files sync in background. This is the "never lose work" moment. |
| **Then** | Phone PWA (`feuille.dev/m/`) | Read/tweak/run experience. Uses same Yjs relay. Validates cross-device without native app investment. |
| **Then** | Desktop runtime registration | Desktop tells orchestrator "I have runtimes." Orchestrator can route phone/cloud requests to them. |
| **Later** | Native phone app | Capacitor wrap for push notifications, offline, app icon. |
| **Later** | CRIU session roaming | Runtime follows you across devices automatically. |

## What Makes This Different From Competitors

| Product | Strength | Gap MRMD fills |
|---------|----------|----------------|
| Jupyter | Ubiquitous | No sync, no offline, no cross-device, no CRDT |
| Observable | Beautiful cloud notebooks | Cloud-only, no local runtimes, no desktop app |
| Obsidian | Great sync, local-first | No code execution |
| VS Code Remote | Great remote dev | Not notebook-first, no phone story |
| Google Colab | Easy GPU access | Cloud-only, no local-first, clunky UX |

MRMD sits at the intersection: **local-first, cloud-synced, multi-runtime, multi-device notebooks.** Nobody else is doing this.
