# Adapter Pipeline Contract

## Purpose

This document defines the recommended adapter-facing pipeline for external
interfaces such as OpenClaw, Slack, Telegram, desktop UI, web UI, or automation
scripts.

This local Python pipeline contract is not itself the OpenClaw plugin or Codex
job runner. It is not a server API or network protocol. External integrations
should consume this pipeline instead of directly editing `.weaveflow` files.

For the OpenClaw-facing core adapter design, see
[openclaw_adapter_design.md](openclaw_adapter_design.md).
For factual research on the real OpenClaw runtime, see
[openclaw_runtime_research.md](openclaw_runtime_research.md).
For the integration readiness freeze and stop criteria before real OpenClaw
work, see [integration_readiness_freeze.md](integration_readiness_freeze.md).
For the outer line-delimited JSON transport that lets another process call the
OpenClaw-like payload path, see
[stdio_bridge_protocol.md](stdio_bridge_protocol.md).
For the local channel adapter contract and smoke flow that ties payload
normalization, sessions, events, rendering, and response payloads together, see
[channel_adapter_contract.md](channel_adapter_contract.md).
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
- execution through `WeaveflowServiceAdapter`
- `AdapterTurnResult` output

Lower-level boundaries are still available when a caller needs them:

- `map_text_to_adapter_request` for deterministic parsing only
- `evaluate_action_permission` for advisory action classification and
  permission decisions
- `prepare_confirmation`, `confirm_request`, and `reject_request` for
  confirmation-only flows
- `WeaveflowServiceAdapter` for direct structured calls
- `event_from_turn_result` for UI event conversion
- `render_event_as_text` for plain text output
- `render_event_for_channel` for channel-specific presentation text

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

### C. Advisory Permission Policy

Function: `evaluate_action_permission`

Responsibility:

- classify actions as `read_only`, `safe_mutation`, `sensitive_mutation`,
  `future_high_risk`, or `unknown`
- explain whether `allow_mutation` or `explicit_confirmation` is needed
- never authenticate users
- never authorize roles
- never execute actions

The current policy is advisory. It is not runtime auth and is not enforced by
`AdapterSession` or `OpenClawAdapter` in this phase.

### D. Confirmation

Functions:

- `prepare_confirmation`
- `confirm_request`
- `reject_request`

Responsibility:

- require confirmation for mutating actions
- never execute actions by itself
- preserve `request_id`

### E. Session Lifecycle

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

### F. Service Adapter

Class: `WeaveflowServiceAdapter`

Responsibility:

- call `weaveflow.service` functions
- enforce `allow_mutation`
- return `AdapterResponse`
- never expose raw stack traces for normal errors

### G. Event Conversion

Function: `event_from_turn_result`

Responsibility:

- convert `AdapterTurnResult` to `AdapterEvent`
- preserve state, action, error, and response data
- keep data JSON-safe

### H. Rendering

Function: `render_event_as_text`

Responsibility:

- convert `AdapterEvent` to chat or log text
- never mutate state
- never hide errors
- provide presentation-only output

### I. Channel-Specific Rendering

Function: `render_event_for_channel`

Responsibility:

- choose a local rendering policy for surfaces such as OpenClaw, Slack,
  Telegram, terminal, or log
- adapt plain text with request IDs, confirmation hints, redaction, truncation,
  and single-line log formatting
- never send messages
- never call external APIs
- never mutate Weaveflow state

## Source Of Truth

`.weaveflow` files and SQLite remain the source of truth for task state.
`AdapterSession` pending confirmations and `AdapterSessionStore` records are
in-memory interaction state only. The session store is not a database.
`AdapterEvent` and `AdapterTranscript` are renderable records, not state
authority. Rendered text is presentation-only.
After wrapper-level rendering, a future external wrapper may create an optional
local `WrapperTranscript` review artifact to capture payload, preflight, route
result, notification, and rendered text for debugging. See
[wrapper_transcript_review.md](wrapper_transcript_review.md). This transcript
layer is not persistent storage and is not the source of truth.

External integrations must not infer task completion from rendered text alone.
Use Weaveflow task files, SQLite state, service calls, or JSON contracts for
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

- mutate `.weaveflow` files directly
- parse human-readable CLI output
- bypass confirmation for mutating actions
- auto-verify tasks
- auto-apply memory proposals
- treat rendered text as the source of truth

## Minimal Code Examples

Read-only status through session:

```python
from pathlib import Path

from weaveflow.adapters import AdapterSession, WeaveflowServiceAdapter

session = AdapterSession(WeaveflowServiceAdapter(Path(".")))
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
from weaveflow.adapters import event_from_turn_result, render_event_as_text

turn = session.confirm("req-task")
event = event_from_turn_result(turn)
message = render_event_as_text(event, style="chat")
print(message)
```

## Integration Choice Guide

| Boundary | Use When |
| --- | --- |
| `AdapterSession` | Building chat-like external integrations, needing confirmation flow, or handling multi-turn interactions. |
| `WeaveflowServiceAdapter` | Caller already has structured actions, no text parsing is needed, or confirmation is handled elsewhere. |
| CLI JSON | Integration cannot import the Python package and read-only status/list/doctor output is enough. |
| `service.py` directly | Building internal tools, needing maximum control, and able to handle `WeaveflowError` correctly. |

## Pipeline Non-Goals

- no OpenClaw plugin implementation inside this Python pipeline contract
- no server API
- no persistent session store
- no authentication policy
- no authorization roles
- no background worker
- no Codex job runner execution inside this pipeline contract
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
