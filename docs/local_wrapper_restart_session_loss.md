# Local Wrapper Restart Session Loss

## Purpose

This document defines expected behavior when `LocalBridgeWrapper` or its
underlying stdio bridge process restarts while confirmations are pending.

The behavior is intentional: pending confirmations are interaction state, not
durable ProjectOps task state. This document is for future external wrappers,
including a future OpenClaw wrapper, before any real OpenClaw integration.

For the structured user-facing notification contract, see
[wrapper_notification_contract.md](wrapper_notification_contract.md).

## Non-Goals

- not real OpenClaw integration
- not process supervision
- not persistent session storage
- not persistent confirmation storage
- not authentication
- not authorization
- not RBAC
- not automatic recovery
- not a server
- not external APIs

## State Model

Durable state lives in ProjectOps workspace storage:

- `.projectops` files
- SQLite task index
- generated artifacts
- generated plans
- generated reports
- memory diffs

Volatile interaction state lives only in memory:

- `AdapterSession` pending normal confirmations
- `LocalBridgeWrapper` pending explicit confirmations
- stdio bridge process in-memory sessions
- `request_id` pending maps
- `bridge_request_id` pending maps

The volatile state is not persistent and must not be treated as the source of
truth for task state.

## Restart Behavior

When the wrapper or bridge process restarts:

- pending normal confirmations are lost
- pending explicit confirmations are lost
- durable ProjectOps task state survives
- read-only commands work after restart
- mutating actions must be repeated and reconfirmed by the user

A `yes` after restart must not confirm an old pending mutation. An old exact
confirmation phrase after restart must not route a sensitive action.

## Recommended User-Facing Message

Future external wrappers should show this message when they detect bridge
restart or session loss:

```text
The ProjectOps bridge restarted. Pending confirmations were cleared. Please repeat the command if needed.
```

Use this message when a wrapper restarts its bridge process, detects an
unexpected bridge exit, or clears local pending confirmation references.
`WrapperNotification` is the recommended result object for carrying this
restart/session-loss notice to future external wrappers and UIs.

## Safe Retry Policy

Safe to retry after restart:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Require the user to repeat and reconfirm:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `attach_result`
- `verify_task`
- `create_final_report`
- `propose_memory_update`

Never auto-retry:

- `auto_run_codex`
- `apply_memory_diff`
- `repair_workspace`
- `delete_artifact`
- `deploy`
- `external_api_action`

## Future OpenClaw Behavior

A future OpenClaw wrapper should:

- detect bridge restart when possible
- clear its own pending confirmation references
- notify the user with the restart/session-loss message
- not auto-confirm old requests
- not route stale exact confirmation phrases
- ask the user to repeat the original command
- preserve durable ProjectOps task state

OpenClaw should remain a channel surface. ProjectOps `.projectops` files and
SQLite remain the durable task source of truth.

## Examples

Lost `create_task` pending confirmation:

```text
create task Investigate auth bug
-> pending_confirmation
bridge restarts
yes
-> PendingConfirmationNotFound
```

Lost `verify_task` explicit confirmation:

```text
verify TASK-0001 passed manual check
-> explicit_confirmation_required
bridge or wrapper restarts
confirm verify_task m-verify
-> PendingExplicitConfirmationNotFound
```

Durable task state surviving restart:

```text
create task Durable task
yes
-> TASK-0001 written under .projectops and indexed in SQLite
bridge restarts
list tasks
-> TASK-0001 still exists
```

## Future Work

- persistent session store
- restart-aware wrapper
- user-visible restart notifications
- request replay protection
- bridge process supervisor
- auth/user identity mapping
- production recovery policy
