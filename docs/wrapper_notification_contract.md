# Wrapper Notification Contract

## Purpose

This document defines local wrapper notification objects for restart,
session-loss, and related wrapper warnings. Future external wrappers, including
a future OpenClaw Node/Gateway wrapper, can use these notifications to tell
users that pending confirmations were cleared.

The contract is local-only. It creates structured notification payloads and
renderable text; it does not detect restarts by itself.

## Non-Goals

- not real OpenClaw integration
- not process supervision
- not persistent notification storage
- not automatic restart detection
- not restart recovery
- not authentication
- not authorization
- not a server
- not a bot
- not external APIs

## Notification Model

`WrapperNotification` fields:

- `contract_version`
- `notification_type`
- `level`
- `message`
- `suggested_action`
- `request_id`
- `bridge_request_id`
- `session_key`
- `action`
- `pending_cleared`
- `retry_safe`
- `requires_user_repetition`
- `metadata`

Supported notification types:

- `session_loss`
- `bridge_restarted`
- `pending_confirmation_cleared`
- `wrapper_warning`
- `wrapper_error`

Supported levels:

- `info`
- `warning`
- `error`

## Session-Loss Notification

Recommended user-facing message:

```text
The ProjectOps bridge restarted. Pending confirmations were cleared. Please repeat the command if needed.
```

Session loss means:

- pending normal confirmations are cleared
- pending explicit confirmations are cleared
- durable ProjectOps task state remains in `.projectops` and SQLite
- users should repeat mutating commands if they still want to proceed

The helper `create_session_loss_notification` creates a warning-level
`WrapperNotification` with `pending_cleared=true` and
`requires_user_repetition=true`.

## Retry-Safety Policy

Safe to retry or read after session loss:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

The user must repeat and reconfirm:

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

`is_retry_safe_after_session_loss` returns this local advisory classification.
It must not be used as authentication or authorization.

## Rendering

`wrapper_notification_to_text(style="chat")` returns concise user-facing text
with the message, suggested action, and correlation ids when available.

`wrapper_notification_to_text(style="log")` returns a single-line operator log
summary with notification type, level, ids, action, and message.

`wrapper_notification_to_payload` returns a JSON-safe dictionary suitable for a
future wrapper response.

Renderers should not expose raw metadata, secrets, or unnecessary absolute
local paths to users.

## Future OpenClaw Usage

A future OpenClaw wrapper should:

- detect bridge restart or session loss if possible
- create a session-loss notification
- render the notification to the user
- clear local pending confirmation references
- not auto-confirm stale requests
- not auto-retry mutating actions
- ask the user to repeat the command if needed

OpenClaw should remain the channel surface. ProjectOps `.projectops` files and
SQLite remain the durable task source of truth.

## Relationship To Existing Docs

- [local_wrapper_restart_session_loss.md](local_wrapper_restart_session_loss.md)
  defines restart/session-loss behavior.
- [stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md)
  defines process lifecycle expectations.
- [adapter_explicit_confirmation.md](adapter_explicit_confirmation.md) defines
  sensitive-action explicit confirmation prompts.
- [channel_adapter_contract.md](channel_adapter_contract.md) defines the local
  channel adapter contract.

## Examples

Chat rendering:

```text
The ProjectOps bridge restarted. Pending confirmations were cleared. Please repeat the command if needed. Repeat the command if you still want to proceed. (request_id=m-1)
```

Log rendering:

```text
type=session_loss level=warning pending_cleared=true retry_safe=false request_id=m-1 action=create_task message=The ProjectOps bridge restarted. Pending confirmations were cleared. Please repeat the command if needed.
```

Payload notification:

```json
{
  "contract_version": "projectops.v1",
  "notification_type": "session_loss",
  "level": "warning",
  "pending_cleared": true,
  "requires_user_repetition": true
}
```
