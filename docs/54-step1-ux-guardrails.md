# Step 1 UX Guardrails: No Regressions + Faster File Open/Switch

> Purpose: Guarantee that Step 1 / 1.5 improves durability without hurting the current "fast, collaborative, file-first" feel.

## TL;DR

We will not ship relay architecture changes directly into the critical editing path without guardrails.

We will ship in phases:

1. **V1 (Dual-write mirror)**: current local sync path remains primary; relay receives mirrored updates. Zero UX risk.
2. **V1.5 (Relay-primary with local warm cache)**: relay becomes source-of-truth, but local open/switch stays instant via cache + optimistic render.

If any KPI regresses, we roll back by env flag in seconds.

---

## Product Invariants (Must Never Regress)

1. **Typing feels immediate**
   - Keystroke-to-local-render stays local and synchronous.
   - Network must never block local typing.

2. **Open document fast**
   - Opening a document shows content immediately (optimistic local content first).

3. **Switching files fast**
   - File-to-file switch remains near-instant for recently viewed docs.

4. **Runtime/file coupling preserved**
   - If Python/R/Julia/Bash writes to a file, editor updates quickly.

5. **Offline-ish resilience**
   - Temporary relay/network interruptions do not block editing.
   - Changes queue and reconcile.

---

## Performance SLOs (Release Gates)

> Baseline first from current production before changing architecture.

### Baseline metrics to collect now
- `doc_open_ttfc_ms`: click file → first content visible
- `doc_switch_ttfc_ms`: switch between two docs → first content visible
- `doc_sync_rtt_ms`: local update → update echoed through sync layer
- `runtime_file_reflect_ms`: runtime writes file → editor view updates

### Target SLOs (must pass before rollout >10%)
- **doc open p95** ≤ current baseline + 10%
- **doc switch p95** ≤ current baseline + 10%
- **sync RTT p95** < 120ms (cloud editor path)
- **runtime file reflect p95** < 500ms
- **error rate** < 0.1% for sync operations

### Stretch goal (your requested improvement)
- **doc open p95** improves by 20-30%
- **doc switch p95** improves by 20-40% for recently opened docs

---

## Architecture Strategy

## V1 (Safe): Dual-Write Mirror (No UX Risk)

### Principle
Keep current path as-is for user interaction; mirror to relay in background.

### Data flow

```
Editor UI
  ↕ (existing fast path)
Local sync + filesystem (current behavior)
  ↘
   Async mirror writer → Cloud relay/Postgres
```

### Why this is safe
- Open/switch/typing path unchanged.
- Relay outages cannot degrade editing UX.
- We still gain durability in background.

### What we validate in V1
- Relay correctness under real traffic
- Save/load fidelity (hash/content equality)
- Throughput and storage sizing
- Reconnect behavior

### Exit criteria to V1.5
- 7 days stable mirror operation
- 0 data mismatch incidents
- Relay write failures < 0.1%

---

## V1.5: Relay-Primary, Local-Warm UX

### Principle
Relay is source-of-truth, but local cache keeps open/switch instant.

### Data flow (open document)

```
User clicks file
  → show last local cached content immediately (optimistic render)
  → attach Yjs doc to relay
  → apply latest relay state
  → if changed, patch view (no full re-render flash)
```

### Data flow (switch files)

```
Keep N hot docs attached in memory (e.g. N=5)
  → switching to hot doc = instant
  → cold doc = optimistic cache + relay hydrate
```

### Required mechanisms
1. **Local warm cache**
   - Keep recent docs in memory + local disk cache
   - key: `userId/project/docPath`
   - includes `content`, `lastHash`, `updatedAt`

2. **Optimistic render**
   - Render cache immediately on open
   - Reconcile with relay state when connected

3. **Connection reuse**
   - Avoid reconnecting WS per switch if possible
   - Keep project-level WS/session multiplexed or hot doc pool

4. **Prefetch on hover/selection**
   - When user hovers/selects file in nav, pre-connect/hydrate silently

5. **Local write queue**
   - If relay is slow/unavailable, queue outgoing updates
   - Flush when reconnected

---

## File-System Consistency Contract (Critical)

To preserve current "automation" feel, we define explicit consistency rules:

1. **Runtime → File → Editor**
   - Runtime writes local file
   - filesystem watcher updates local Yjs
   - local Yjs sends update to relay
   - all clients reflect update

2. **Remote edit → Relay → Local file**
   - Relay update applied to local Yjs
   - local Yjs writes file atomically
   - runtime sees updated file contents

3. **Conflict resolution**
   - Yjs resolves text conflicts
   - local file projection uses latest Yjs materialized text

4. **No direct competing writers**
   - Local file projection is the single writer for markdown docs
   - external runtime writes enter through filesystem watcher path

---

## Rollout Plan (Feature-Flagged)

Use a single env flag everywhere:

`SYNC_MODE=legacy | mirror | relay_primary`

### Phase A: `legacy`
- Current behavior only
- Add instrumentation only

### Phase B: `mirror` (V1)
- Current behavior primary
- Async mirror writes to relay
- Compare checksums (`local_hash` vs `relay_hash`)

### Phase C: `relay_primary` for internal user only
- Enable for your account only
- Keep automatic fallback to `legacy` on any sync health failure

### Phase D: gradual rollout
- 10% users → 50% → 100%
- Gate on SLOs after each stage

### Rollback
- Set `SYNC_MODE=legacy` and restart service
- No migration required
- Works immediately

---

## Speed Improvements We Can Realistically Get

1. **Hot-doc cache** (biggest gain for switching)
   - Keep last 5 docs live in memory
   - Instant switch for common workflows

2. **Optimistic open**
   - render cached content before relay round-trip
   - perceived speed significantly better

3. **Nav-driven prefetch**
   - preconnect docs adjacent to current file
   - e.g., opening 02 file after 01 becomes instant

4. **Avoid full editor re-init on switch**
   - patch document model instead of teardown/recreate

5. **Debounce tuning**
   - write debounce down to 300-500ms for active doc,
   - keep 1-2s for background docs

---

## Test Matrix (Must Pass)

### Functional
- open/save/switch docs
- concurrent edits in two tabs
- runtime writes to file reflected in editor
- restart editor container and verify state intact

### Failure
- kill relay while editing
- kill editor container while editing
- Postgres restart during active session
- network latency injection (100-300ms)

### Performance
- open 100-file project and measure p50/p95 open/switch
- rapid file hopping (10 switches in 5s)
- large doc (500KB markdown) open/switch

---

## Definition of Done for V1.5

- Relay is source-of-truth for synced docs
- No UX regression against baseline SLOs
- File open/switch p95 improved for hot docs
- Runtime-to-editor file reflection remains under target
- One-command rollback to legacy path confirmed in staging and prod

---

## Decision Rule

If there is a tradeoff between architectural purity and current UX quality:

**Choose UX quality.**

MarkCo's current experience is the product advantage. Architecture must support it, not weaken it.
