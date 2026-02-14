# feuille.dev — Quick Explain

`feuille-services` is the cloud/platform control plane around MRMD.

It runs five services:
- orchestrator (`:3000`)
- auth-service (`:3001`)
- compute-manager (`:3002`)
- publish-service (`:3003`)
- resource-monitor (`:3004`)

## User lifecycle

1. User logs in via GitHub OAuth
2. Orchestrator starts runtime container via compute-manager
3. Orchestrator starts editor container running `mrmd-server`
4. Requests to `/u/<userId>/...` are proxied by orchestrator to that editor container

## Scaling model

Runtime containers can be checkpointed/migrated (CRIU + EC2), while editor containers remain the interactive front-end path.
