# Local Wrapper Flow

## Purpose

This document describes the local wrapper smoke flow that combines bridge
health checks, permission preflight, and stdio bridge routing decisions.

The flow is intended to show how a future external wrapper, such as a future
OpenClaw Node/Gateway wrapper, can decide whether a raw channel payload should
be routed into the ProjectOps stdio bridge.

This is local-only. It is not real OpenClaw integration.

## Non-Goals

- not real OpenClaw integration
- not a server
- not a bot
- not process supervision
- not persistent sessions
- not authentication
- not authorization
- not external APIs
- not auto-running Codex

## Flow

```text
raw payload
-> bridge health check
-> permission preflight
-> route/block decision
-> stdio bridge
-> WrapperRouteResult
```

`LocalBridgeWrapper` owns a local stdio bridge subprocess. It runs a ping
health check before normal routing, preflights raw payloads, and returns a
`WrapperRouteResult` with the routing decision and any bridge response.

## Routing Decisions

- Read-only actions route to the bridge.
- Safe mutation actions route only to establish pending confirmation.
- `yes` and `no` confirmation responses route directly to the bridge.
- Sensitive mutation actions require explicit confirmation before routing.
- Future high-risk actions block; every future high-risk action stays outside
  bridge routing until a stronger policy exists.
- Invalid payloads block.

The wrapper does not silently retry mutating actions and does not auto-confirm
anything.

## Why Safe Mutation Can Route

Routing a safe mutation to the bridge does not execute it immediately. The
bridge and `AdapterSession` return `pending_confirmation` and store the pending
request in the running bridge process.

A later `yes` or `no` payload confirms or rejects the pending request in the
same bridge session. This preserves existing bridge session behavior instead
of inventing a separate confirmation store in the wrapper.

The route reason for this case is
`route_to_establish_pending_confirmation`.

## Why Sensitive Mutation Is Held

Sensitive mutation actions are held by default. A sensitive mutation such as
`verify_task` or `create_final_report`
need stronger explicit confirmation before they should be routed by a future
wrapper.

This phase does not implement a full explicit confirmation UX. Instead,
`LocalBridgeWrapper` returns a `WrapperRouteResult` telling the caller that
explicit confirmation is required.

## Health Check

The wrapper runs a ping health check before routing payloads. This confirms the
bridge process can respond with a valid stdio bridge response and `pong=true`.

The health check is bridge process health only. Workspace health still requires
`doctor`.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw payload
-> LocalBridgeWrapper-like process wrapper
-> preflight
-> route/block/ask confirmation
-> bridge response
-> rendered message to user
```

OpenClaw should remain the channel surface. The wrapper should own user-facing
decisions, while ProjectOps remains the local task kernel.

## Source Of Truth

`.projectops` files and SQLite remain the task source of truth. The bridge
process owns in-memory session state while it is running. Wrapper results are
routing records only and must not be treated as task state.

## Future Work

- real OpenClaw wrapper
- process restart policy
- persistent session store
- explicit confirmation UX
- permission enforcement integration
- auth/user mapping
- production diagnostics and logging
