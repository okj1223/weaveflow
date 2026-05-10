# Stale Confirmation Notifications

## Purpose

This document defines user-facing notifications for stale, consumed, rejected,
missing, or mismatched explicit confirmation attempts.

The goal is to let future wrappers render a clear message when an explicit
confirmation phrase cannot be used, without routing the original payload or
executing an action.

This is local-only wrapper behavior. It is not real OpenClaw integration.

## Non-Goals

- not authentication
- not authorization
- not RBAC
- not persistence
- not cross-process replay protection
- not real OpenClaw integration
- not a server
- not external APIs

## Replay Notification Types

`WrapperNotification` supports these explicit-confirmation notification types:

- `stale_confirmation_replay`: the phrase/key was already consumed or is stale.
- `rejected_confirmation_replay`: the confirmation was previously rejected.
- `missing_confirmation`: no pending confirmation exists for the supplied id.
- `explicit_confirmation_mismatch`: the typed phrase did not match the prompt.

## User-Facing Behavior

A stale consumed confirmation must not execute again. The wrapper should report
`StaleConfirmationReplay`, attach a `stale_confirmation_replay` notification,
and ask the user to repeat the original command if they still want to proceed.
Future wrappers should render that repeat original command guidance clearly.

A rejected confirmation must not execute. The wrapper should use
`rejected_confirmation_replay` and ask the user to repeat the original command
if needed.

A missing confirmation should use `missing_confirmation` and explain that no
pending confirmation was found. This can happen after restart, shutdown, or a
wrong request id.

A wrong exact phrase should use `explicit_confirmation_mismatch` and ask the
user to type the exact confirmation phrase shown. This mismatch does not clear
the pending prompt.

Plain `yes` is not enough for sensitive actions such as `verify_task`,
`attach_result`, or `create_final_report`.

## Wrapper Metadata Contract

When a notification is available, `LocalBridgeWrapper` places a JSON-safe
payload at:

```text
WrapperRouteResult.metadata["notification"]
```

The payload is a serialized `WrapperNotification`. Future wrappers can render
the notification without parsing human-readable bridge output.

## Future OpenClaw Usage

A future OpenClaw wrapper should:

- render the notification to the user
- never route stale consumed confirmations
- never auto-confirm stale requests
- tell the user to repeat the original command if needed
- keep the exact confirmation prompt visible when mismatch occurs
- not treat this as authentication

OpenClaw should remain the channel surface. ProjectOps remains the local task
kernel and durable source of truth.

## Relationship To Replay Protection

`replay_protection.py` detects stale consumed or rejected confirmations.
`wrapper_notifications.py` turns replay states and explicit-confirmation errors
into user-facing notifications. `LocalBridgeWrapper` attaches those
notifications to `WrapperRouteResult` metadata.

Replay notification behavior is local-only, in-memory, and not persistent.

## Examples

Consumed exact phrase replay:

```text
confirm verify_task m-verify
-> StaleConfirmationReplay
-> notification_type=stale_confirmation_replay
-> suggested_action="Repeat the original command if you still want to proceed."
```

Wrong phrase mismatch:

```text
yes
-> ExplicitConfirmationMismatch
-> notification_type=explicit_confirmation_mismatch
-> suggested_action="Type the exact confirmation phrase shown."
```

Missing pending confirmation:

```text
confirm verify_task missing
-> PendingExplicitConfirmationNotFound
-> notification_type=missing_confirmation
-> suggested_action="Repeat the original command if you still want to proceed."
```
