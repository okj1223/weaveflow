# Adapter Pipeline Contract

## Purpose

This document defines the recommended adapter-facing pipeline for external
interfaces such as OpenClaw, Slack, Telegram, desktop UI, web UI, or automation
scripts.

This is not OpenClaw integration. This is not a server API. This is not a
network protocol. This is a local Python integration contract. External
integrations should consume this pipeline instead of directly editing
`.projectops` files.

For the future OpenClaw-specific adapter design, see
[openclaw_adapter_design.md](openclaw_adapter_design.md).
The local placeholder `OpenClawAdapter` skeleton consumes this pipeline without
importing or integrating real OpenClaw.
It also accepts raw OpenClaw-like payload dictionaries through
`OpenClawAdapter.handle_payload`, normalizes them locally, and returns
JSON-safe payload dictionaries.

## Recommended Boundary

The preferred high-level boundary for future chat-like integrations is
`AdapterSession`.

Use `AdapterSession` because it combines:

- deterministic intent mapping
- confirmation gating
- execution through `ProjectOpsServiceAdapter`
- `AdapterTurnResult` output

Lower-level boundaries are still available when a caller needs them:

- `map_text_to_adapter_request` for deterministic parsing only
- `prepare_confirmation`, `confirm_request`, and `reject_request` for
  confirmation-only flows
- `ProjectOpsServiceAdapter` for direct structured calls
- `event_from_turn_result` for UI event conversion
- `render_event_as_text` for plain text output

## Pipeline Stages

### A. External Text Input

Example:

```text
create task Investigate auth bug
```

### B. Intent Mapping

Function: `map_text_to_adapter_request`

Output: `IntentMappingResult`

Responsibility:

- parse simple deterministic commands
- identify mutating vs read-only actions
- produce `AdapterRequest`
- never execute actions

### C. Confirmation

Functions:

- `prepare_confirmation`
- `confirm_request`
- `reject_request`

Responsibility:

- require confirmation for mutating actions
- never execute actions by itself
- preserve `request_id`

### D. Session Lifecycle

Class: `AdapterSession`

Responsibility:

- hold pending confirmations in memory
- execute read-only commands immediately
- hold mutating commands until confirmed
- return `AdapterTurnResult`

Store boundary: `AdapterSessionStore`

Responsibility:

- keep `AdapterSession` objects by session key
- keep latest pending request IDs by session key
- carry pending confirmations across turns for channel adapters
- remain in-memory only
- avoid acting as a task database or source of truth

### E. Service Adapter

Class: `ProjectOpsServiceAdapter`

Responsibility:

- call `projectops.service` functions
- enforce `allow_mutation`
- return `AdapterResponse`
- never expose raw stack traces for normal errors

### F. Event Conversion

Function: `event_from_turn_result`

Responsibility:

- convert `AdapterTurnResult` to `AdapterEvent`
- preserve state, action, error, and response data
- keep data JSON-safe

### G. Rendering

Function: `render_event_as_text`

Responsibility:

- convert `AdapterEvent` to chat or log text
- never mutate state
- never hide errors
- provide presentation-only output

## Source Of Truth

`.projectops` files and SQLite remain the source of truth for task state.
`AdapterSession` pending confirmations and `AdapterSessionStore` records are
in-memory interaction state only. The session store is not a database.
`AdapterEvent` and `AdapterTranscript` are renderable records, not state
authority. Rendered text is presentation-only.

External integrations must not infer task completion from rendered text alone.
Use ProjectOps task files, SQLite state, service calls, or JSON contracts for
authoritative workflow state.

## Mutation Policy

Read-only operations:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Mutating operations:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `attach_result`
- `verify_task`
- `create_final_report`
- `propose_memory_update`

Rules:

- mutating operations require `allow_mutation=True`
- chat-like integrations should request confirmation first
- verification and final report generation should be treated as explicit user
  actions
- memory proposal generation does not apply global memory automatically

## Error Policy

- mapping failures become `IntentMappingResult` errors
- confirmation failures remain non-executable
- adapter errors become `AdapterResponse` with `ok: false`
- session errors become `AdapterTurnResult` with `state: error`
- events with errors become `turn_error`
- renderers must show errors instead of hiding them

Known error names include:

- `EmptyIntent`
- `UnknownIntent`
- `InvalidIntent`
- `MutationNotAllowed`
- `UnsupportedAction`
- `InvalidAdapterRequest`
- `PendingConfirmationNotFound`
- `WorkspaceNotFoundError`
- `TaskNotFoundError`
- `MissingPlanError`
- `MissingResultFileError`
- `InvalidVerificationStatusError`

## Future OpenClaw Usage

Recommended future shape:

```text
OpenClaw message
-> adapter-specific message wrapper
-> AdapterSession.handle_text
-> if pending_confirmation, ask user to confirm
-> user confirms or rejects
-> AdapterSession.confirm or AdapterSession.reject
-> event_from_turn_result
-> render_event_as_text(style="chat")
-> send rendered message back to OpenClaw user
```

Current local skeleton payload shape:

```text
Raw OpenClaw-like payload
-> normalize_openclaw_message_payload
-> OpenClawMessage
-> OpenClawAdapter.handle_message
-> OpenClawResponse
-> openclaw_response_to_payload
-> JSON-safe response payload
```

OpenClaw should not:

- mutate `.projectops` files directly
- parse human-readable CLI output
- bypass confirmation for mutating actions
- auto-verify tasks
- auto-apply memory proposals
- treat rendered text as the source of truth

## Minimal Code Examples

Read-only status through session:

```python
from pathlib import Path

from projectops.adapters import AdapterSession, ProjectOpsServiceAdapter

session = AdapterSession(ProjectOpsServiceAdapter(Path(".")))
turn = session.handle_text("status", request_id="req-status")
print(turn.state, turn.ok)
```

Mutating create task requiring confirmation:

```python
turn = session.handle_text(
    "create task Investigate auth bug",
    request_id="req-task",
)
if turn.state == "pending_confirmation":
    print("Ask the user to confirm req-task")
```

Confirmed create task converted to event and rendered as text:

```python
from projectops.adapters import event_from_turn_result, render_event_as_text

turn = session.confirm("req-task")
event = event_from_turn_result(turn)
message = render_event_as_text(event, style="chat")
print(message)
```

## Integration Choice Guide

| Boundary | Use When |
| --- | --- |
| `AdapterSession` | Building chat-like external integrations, needing confirmation flow, or handling multi-turn interactions. |
| `ProjectOpsServiceAdapter` | Caller already has structured actions, no text parsing is needed, or confirmation is handled elsewhere. |
| CLI JSON | Integration cannot import the Python package and read-only status/list/doctor output is enough. |
| `service.py` directly | Building internal tools, needing maximum control, and able to handle `ProjectOpsError` correctly. |

## Non-Goals

- no OpenClaw integration yet
- no server API
- no persistent session store
- no authentication policy
- no authorization roles
- no background worker
- no auto-running Codex
- no external API calls

## Future Work

- OpenClaw adapter design
- OpenClaw message wrapper
- persistent session store
- auth/permission policy
- channel-specific renderer policy
- richer task summaries
- execution queue
- Codex execution automation policy
