# Adapter Permission Policy

## Purpose

This document defines the local adapter action permission policy for future
external adapters. The policy classifies adapter actions and returns advisory
permission decisions before an adapter executes a request.

## Non-Goals

- This is not authentication.
- This is not authorization runtime.
- This is not OpenClaw integration.
- This does not call external APIs.
- This does not execute actions.
- This does not persist permissions.
- This does not implement roles.

## Action Categories

- `read_only`: actions that inspect ProjectOps state without changing it.
- `safe_mutation`: supported mutating actions that require confirmation.
- `sensitive_mutation`: supported mutating actions that require explicit
  confirmation.
- `future_high_risk`: future actions that are not supported yet and should be
  blocked.
- `unknown`: unsupported actions not recognized by the policy.

## Current Action Classification

Read-only:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Safe mutating:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `propose_memory_update`

Sensitive mutating:

- `attach_result`
- `verify_task`
- `create_final_report`

Future high-risk:

- `auto_run_codex`
- `apply_memory_diff`
- `repair_workspace`
- `delete_artifact`
- `edit_task_history`
- `deploy`
- `external_api_action`

## Permission Decision Behavior

`get_action_policy(action)` returns the static action classification.

`evaluate_action_permission(action, allow_mutation=False,
explicit_confirmation=False)` returns a `PermissionDecision`.

- Read-only actions are allowed without mutation flags.
- Safe mutations require `allow_mutation=True`.
- Sensitive mutations require both `allow_mutation=True` and
  `explicit_confirmation=True`.
- Future high-risk actions are blocked for now.
- Unknown actions are blocked.

## Current Enforcement Status

This module is advisory in PHASE 10-E. Existing `AdapterSession` and
`OpenClawAdapter` behavior does not change yet. Future OpenClawAdapter
enforcement may use this policy to decide whether to execute, ask for
confirmation, ask for explicit confirmation, or block a request.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw message
-> intent mapping
-> permission policy
-> if read-only, execute
-> if safe mutation, require confirmation
-> if sensitive mutation, require explicit confirmation
-> if future high-risk, block
-> render result
```

## Safety Notes

- Auto-running Codex is future high-risk.
- Applying memory diffs is future high-risk.
- Repairing workspace state is future high-risk.
- Deleting artifacts is future high-risk.
- Deployment and external API actions are future high-risk.
