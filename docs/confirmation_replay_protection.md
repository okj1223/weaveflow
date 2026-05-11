# Confirmation Replay Protection

## Purpose

This document defines in-memory replay protection for explicit confirmation
phrases used by `LocalBridgeWrapper`.

Sensitive actions require exact confirmation. After a confirmation phrase is
used to route a sensitive action, the same confirmation key is treated as
single-use and cannot execute again in the same wrapper process.

This is local-only replay protection. It is not real OpenClaw integration.

## Non-Goals

- not authentication
- not authorization
- not RBAC
- not persistence
- not cross-process protection
- not real OpenClaw integration
- not a server
- not a cryptographic replay protection system
- not external API security

## Replay Problem

Sensitive actions such as `verify_task`, `attach_result`, and
`create_final_report` require an exact confirmation phrase. That phrase should
not be reusable after execution. If a user or channel surface accidentally
repeats an already-consumed message, the wrapper should not route the sensitive
action a second time.

## Current Scope

Replay protection is implemented only within one `LocalBridgeWrapper` process.
`ConfirmationReplayGuard` keeps records in memory only. Records are cleared on
shutdown or restart.

There is no persistent replay protection in this phase. Cross-process replay
protection is future work and would need explicit durable state.

Wrapper-facing notification behavior for stale, rejected, missing, and
mismatched explicit confirmations is documented in
[stale_confirmation_notifications.md](stale_confirmation_notifications.md).

## Confirmation States

- `pending`: an explicit confirmation prompt exists and may execute once.
- `consumed`: the exact phrase was accepted and the payload was routed.
- `rejected`: the confirmation was rejected by policy or wrapper state.
- `unknown`: no replay record exists for the requested key.

## LocalBridgeWrapper Behavior

When a sensitive action creates a pending explicit confirmation,
`LocalBridgeWrapper` registers a `pending` replay record.

When the exact phrase arrives, the wrapper checks `ConfirmationReplayGuard`
before routing the original payload. If the record is still `pending`, the
wrapper routes the payload with `explicit_confirmation=True`, then marks the
record `consumed`.

If the same phrase/key is submitted again, the wrapper blocks it with
`StaleConfirmationReplay`. If a record is `rejected`, the wrapper blocks it
with `RejectedConfirmationReplay`.

Those wrapper errors now include JSON-safe notification metadata at
`WrapperRouteResult.metadata["notification"]` when a notification is available.

A wrong phrase does not consume the record. The prompt remains pending so the
user can provide the correct exact phrase.

Shutdown clears pending explicit confirmations and replay records because both
are in-memory interaction state.

## Future OpenClaw Behavior

A future OpenClaw wrapper should:

- keep a replay guard per wrapper or session scope
- never route a consumed confirmation again
- notify the user cleanly on stale replay
- not rely on replay guard for auth
- add persistent replay protection only as explicit future work

OpenClaw should remain the channel surface. Weaveflow remains the local task
kernel and source of truth for durable task state.

## Safety Notes

This is not authentication. User identity mapping still belongs to a future
wrapper and auth layer.

Confirmation phrases should not include secrets. Replay records should not
store full raw payloads, credentials, tokens, or unnecessary absolute local
paths.

Cross-process replay protection requires persistent state and is not
implemented here. This phase intentionally stays in-memory and local-only.

## Examples

First exact phrase executes:

```text
verify TASK-0001 passed manual check
-> explicit_confirmation_required
confirm verify_task m-verify
-> payload routed and replay state becomes consumed
```

Second exact phrase is blocked:

```text
confirm verify_task m-verify
-> StaleConfirmationReplay
```

Wrong phrase keeps pending:

```text
yes
-> ExplicitConfirmationMismatch
confirm verify_task m-verify
-> payload routed
```

Restart clears replay records:

```text
confirm verify_task m-verify
-> consumed in wrapper process A
wrapper restarts
-> replay records are gone because they were not persistent
```
