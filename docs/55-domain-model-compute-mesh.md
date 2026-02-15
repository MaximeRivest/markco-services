# Domain Model Spec: MarkCo Personal Compute Mesh

> Purpose: Define the canonical entities, relationships, and state machines for the "work anywhere, compute anywhere" experience.
>
> Product name: **MarkCo**
> Underlying stack/libraries: **MRMD** (`mrmd-*`)

## 1) Product Guarantees (first principles)

These are non-negotiable:

1. **Local-first interaction**
   - Typing and document navigation are immediate on the active client.
2. **Global convergence**
   - All clients converge on identical document state.
3. **Execution continuity**
   - Runs survive client disconnects.
4. **Project ubiquity**
   - Files/projects opened on one device become available on others.
5. **Device-aware compute routing**
   - Compute can route to desktop, home server/GPU, cloud, or phone based on policy.

---

## 2) Core Entities

## 2.1 User

A person account in MarkCo.

```ts
type User = {
  id: UUID;
  email: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  plan: 'free' | 'pro' | 'team';
  createdAt: ISODate;
}
```

## 2.2 Device

A client installation owned by a user (desktop app, phone app, web app session, server agent).

```ts
type Device = {
  id: UUID;                    // stable installation id
  userId: UUID;
  kind: 'desktop' | 'phone' | 'web' | 'server-agent';
  name: string;                // e.g. "MacBook Pro", "Home GPU Server"
  os?: string;
  appVersion?: string;
  mrmdVersion?: string;
  lastSeenAt: ISODate;
  status: 'online' | 'offline' | 'sleeping';
  createdAt: ISODate;
}
```

## 2.3 Node Capability (ephemeral heartbeat)

Runtime and hardware profile currently available on a device.

```ts
type NodeCapability = {
  deviceId: UUID;
  online: boolean;
  heartbeatAt: ISODate;

  runtimes: Array<{
    language: 'python' | 'r' | 'julia' | 'bash' | 'js';
    version?: string;
    available: boolean;
  }>;

  gpu?: {
    vendor?: string;
    model?: string;
    vramMb?: number;
    cuda?: boolean;
  };

  resources: {
    cpuCores?: number;
    memoryMb?: number;
    memoryFreeMb?: number;
    batteryPct?: number;
    charging?: boolean;
    network: 'offline' | 'metered' | 'wifi' | 'ethernet';
  };

  policy: {
    allowRemoteExecution: boolean;
    allowHeavyJobs: boolean;
    allowWhenOnBattery: boolean;
    maxConcurrentRuns: number;
  };
}
```

## 2.4 Project

A syncable workspace root containing docs/assets/config, independent of any one machine path.

```ts
type Project = {
  id: UUID;
  userId: UUID;
  slug: string;                // unique per user
  displayName: string;

  // canonical metadata
  configPath: 'mrmd.md';
  source: 'created' | 'imported-git' | 'opened-local';

  // sync + projection controls
  syncMode: 'active' | 'paused';
  visibility: 'private' | 'shared';

  createdAt: ISODate;
  updatedAt: ISODate;
}
```

## 2.5 Project Attachment

A project mounted/materialized on a specific device.

```ts
type ProjectAttachment = {
  id: UUID;
  projectId: UUID;
  deviceId: UUID;

  localRootPath?: string;      // e.g. /home/maxime/notes/proj-a
  state: 'attaching' | 'attached' | 'stale' | 'detached';
  lastSyncedAt?: ISODate;

  // for conflict/repair
  localHeadHash?: string;
  cloudHeadHash?: string;
}
```

## 2.6 Document

Logical markdown/qmd document under a project.

```ts
type Document = {
  id: UUID;
  projectId: UUID;
  path: string;                // e.g. "02-analysis/01-index"
  ext: '.md' | '.qmd';

  // Materialized content and CRDT state
  textSnapshot?: string;
  yjsState?: bytes;
  contentHash?: string;

  sizeBytes: number;
  updatedAt: ISODate;
  createdAt: ISODate;
}
```

Unique key: `(projectId, path)`

## 2.7 Asset

Binary attachment referenced by documents.

```ts
type Asset = {
  id: UUID;
  projectId: UUID;
  path: string;                // e.g. _assets/plot.png
  contentHash: string;         // sha256
  mimeType: string;
  sizeBytes: number;
  storageKey: string;          // object store key
  createdAt: ISODate;
}
```

## 2.8 Runtime Session

Live execution context for a language + project environment.

```ts
type RuntimeSession = {
  id: UUID;
  userId: UUID;
  projectId: UUID;
  language: 'python' | 'r' | 'julia' | 'bash' | 'js';

  // where this session currently lives
  hostType: 'device' | 'cloud';
  hostDeviceId?: UUID;         // if hostType='device'
  hostRuntimeId?: string;      // backing container/process id

  state: 'cold' | 'starting' | 'running' | 'checkpointed' | 'migrating' | 'error';

  // affinity and reproducibility
  environmentHash?: string;    // lockfile/env identity
  sessionAffinityKey?: string; // doc/cell affinity

  startedAt?: ISODate;
  updatedAt: ISODate;
}
```

## 2.9 Run (execution instance)

One submitted execution request tied to a session.

```ts
type Run = {
  id: UUID;
  userId: UUID;
  projectId: UUID;
  documentId?: UUID;
  cellId?: string;

  sessionId: UUID;
  language: RuntimeSession['language'];
  code: string;

  state: 'queued' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

  routedTo: {
    hostType: 'device' | 'cloud';
    deviceId?: UUID;
    reason: 'session-affinity' | 'gpu-required' | 'availability' | 'fallback';
  };

  startedAt?: ISODate;
  completedAt?: ISODate;
  error?: { type?: string; message: string };
}
```

## 2.10 Run Stream Event

Durable stream of stdout/stderr/display/progress for a run.

```ts
type RunEvent = {
  id: UUID;
  runId: UUID;
  seq: number;                 // monotonically increasing per run
  type: 'stdout' | 'stderr' | 'display' | 'progress' | 'stdin-request' | 'stdin-response' | 'result' | 'error';
  payload: any;
  createdAt: ISODate;
}
```

---

## 3) Relationship Model

```text
User 1---N Device
User 1---N Project
Project 1---N Document
Project 1---N Asset
Project 1---N ProjectAttachment
Project 1---N RuntimeSession
RuntimeSession 1---N Run
Run 1---N RunEvent

Device 1---N ProjectAttachment
Device 1---N RuntimeSession (when hostType=device)
```

---

## 4) Canonical State Machines

## 4.1 Project Attachment

`detached -> attaching -> attached -> stale -> attached | detached`

- `stale` means local projection diverged / lagging and needs catch-up.

## 4.2 Runtime Session

`cold -> starting -> running -> checkpointed -> running`

Also:
- `running -> migrating -> running`
- any -> `error`

## 4.3 Run

`queued -> scheduled -> running -> completed|failed|cancelled`

Rules:
- only one terminal state
- run events append-only
- `result` or `error` event must be present before terminal state commit

---

## 5) Command and Event Contracts

## 5.1 Commands (intent)

```ts
type Command =
  | { type: 'project.openLocalPath'; deviceId: UUID; localPath: string }
  | { type: 'document.open'; projectId: UUID; path: string }
  | { type: 'run.submit'; sessionId: UUID; code: string; documentId?: UUID; cellId?: string }
  | { type: 'session.ensure'; projectId: UUID; language: string }
  | { type: 'session.migrate'; sessionId: UUID; target: 'cloud' | { deviceId: UUID } }
  | { type: 'run.cancel'; runId: UUID }
```

## 5.2 Domain Events (facts)

```ts
type DomainEvent =
  | { type: 'project.attached'; projectId: UUID; deviceId: UUID }
  | { type: 'document.updated'; projectId: UUID; path: string; hash: string }
  | { type: 'session.running'; sessionId: UUID; hostType: 'device' | 'cloud' }
  | { type: 'run.started'; runId: UUID }
  | { type: 'run.event'; runId: UUID; eventType: RunEvent['type']; seq: number }
  | { type: 'run.completed'; runId: UUID }
  | { type: 'run.failed'; runId: UUID; message: string }
```

---

## 6) Scheduling Policy (compute can happen anywhere)

When `run.submit` occurs, scheduler ranks candidate nodes.

Candidate set:
1. device hosting current session (affinity)
2. other online user devices/agents with required runtime
3. cloud runtime
4. cold-start cloud fallback

Score example:

```text
score =
  + 50 if session already running on node
  + 30 if required GPU available
  + 20 if low estimated queue
  + 10 if low latency to requester
  - 40 if policy disallows heavy jobs (phone on battery, metered net)
  - 30 if node unstable (heartbeat jitter/high failures)
```

Tie-breaker: prefer session affinity, then deterministic by node id.

User override always possible (`Run on...`).

---

## 7) Public Computer + Residential GPU Scenario

Design requirement: no inbound port exposure at home.

Solution:
- Home server runs `server-agent` with outbound persistent WebSocket tunnel to MarkCo control plane.
- Control plane relays MRP requests/responses through this tunnel.
- Public computer only talks to MarkCo web app; never directly to home server.

Security constraints:
- agent authenticated with short-lived signed token + device key
- per-run authorization bound to user/session
- tunnel scoped to owner’s resources only

---

## 8) File/Doc Consistency Contract

Three states must converge:
- `S_ui` (what editor shows)
- `S_sync` (Yjs CRDT state)
- `S_fs` (materialized markdown files)

Contract:
1. local edit: `S_ui -> S_sync` immediately
2. sync propagation: `S_sync` converges across clients
3. projection: `S_sync -> S_fs` with bounded lag
4. external file write (runtime): `S_fs -> S_sync -> other clients`

Execution barrier:
- Before run starts, enforce projection watermark so runtime reads latest `S_sync` view for target docs.

---

## 9) Minimal V1 Subset (implement now)

For immediate build, implement these entities only:
- User
- Device (basic)
- Project
- Document (`yjsState`, `textSnapshot`)
- RuntimeSession (cloud-hosted only at first)
- Run + RunEvent

Deferred:
- full asset routing
- full session migration UI
- advanced policy scoring

---

## 10) API Surface (minimum)

### Sync
- `WS /sync/:userId/:project/:docPath`
  - Yjs protocol frames

### Projects
- `POST /api/projects/open-local`
- `GET /api/projects`
- `GET /api/projects/:id/documents`

### Sessions/Runs
- `POST /api/sessions/ensure`
- `POST /api/runs`
- `POST /api/runs/:id/cancel`
- `GET /api/runs/:id`
- `WS /api/runs/:id/events`

### Devices/Agents
- `WS /api/agents/connect`
- `POST /api/devices/heartbeat`

---

## 11) Observability (must-have)

Metrics:
- doc open p50/p95
- doc switch p50/p95
- sync RTT p50/p95
- projection lag (`S_sync -> S_fs`)
- run queue latency
- run duration by node type
- scheduler fallback rate (device->cloud)

Audit logs:
- run routing decisions and reason
- session migration events
- agent connect/disconnect

---

## 12) Why this model supports the dream

- "I move from computer to phone": shared Project/Document state + durable RunEvent stream.
- "I can watch long jobs anywhere": Run is independent of client, stream is durable.
- "My home GPU works from public computer": server-agent outbound tunnel.
- "Any opened markdown becomes available everywhere": project attachment + document indexing.
- "Compute can happen on any device": scheduler over NodeCapability + policy.

This gives a consistent conceptual model and implementation boundary for the full MarkCo experience.
