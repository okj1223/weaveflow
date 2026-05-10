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

Restart and session-loss behavior is documented in
[local_wrapper_restart_session_loss.md](local_wrapper_restart_session_loss.md).

## Routing Decisions

- Read-only actions route to the bridge.
- Safe mutation actions route only to establish pending confirmation.
- `yes` and `no` confirmation responses route directly to the bridge.
- Sensitive mutation actions require explicit confirmation before routing.
- Future high-risk actions block; every future high-risk action stays outside
  bridge routing until a stronger policy exists.
- Invalid payloads block.

The wrapper does not silently retry mutating actions and does not confirm a
mutation before the user provides the normal confirmation response or the exact
sensitive-action phrase.

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

`LocalBridgeWrapper` now returns a `WrapperRouteResult` telling the caller that
explicit confirmation is required and stores the original payload plus prompt in
memory.

Wrappers can use
[adapter_explicit_confirmation.md](adapter_explicit_confirmation.md) to build a
prompt, require the exact confirmation phrase, and then route the original
payload with `explicit_confirmation=True`.

## Sensitive Action Explicit Confirmation Flow

Sensitive actions are held before routing. The wrapper creates an explicit
confirmation prompt, stores the original raw payload and prompt in memory, and
returns `route_reason="explicit_confirmation_required"`.

Plain `yes` or `no` is not enough for sensitive actions. The user must provide
the exact confirmation phrase, such as `confirm verify_task m-verify`. After the
phrase matches, `LocalBridgeWrapper.handle_explicit_confirmation` routes the
stored original payload and completes the bridge confirmation turn for that
same request.

Pending explicit confirmations are in-memory only. They are cleared after a
successful route attempt, cleared on wrapper shutdown, and lost if the wrapper
or bridge process restarts.

Normal pending confirmations are also in-memory only because they live inside
the running bridge process and `AdapterSession`.

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
