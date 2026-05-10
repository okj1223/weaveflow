# OpenClaw Adapter Design

## Purpose

This document defines the future OpenClaw adapter design before implementation.

This is not OpenClaw integration. This does not import OpenClaw. This does not
call OpenClaw APIs. This does not create a bot or server. This is a design
contract for a future integration.

This design is still based on the local placeholder skeleton until validated
against real runtime APIs. See
[openclaw_runtime_research.md](openclaw_runtime_research.md) for current
runtime findings and
[openclaw_integration_gap_analysis.md](openclaw_integration_gap_analysis.md)
for the skeleton comparison.
The local process bridge intended for future OpenClaw plugin proof-of-concept
work is documented in [stdio_bridge_protocol.md](stdio_bridge_protocol.md).
The companion process-wrapper contract is documented in
[stdio_bridge_client_contract.md](stdio_bridge_client_contract.md).

## Intended Role Of OpenClaw

OpenClaw should act as:

- channel surface
- message intake layer
- user interaction layer
- notification surface
- external session carrier

OpenClaw should not be:

- the source of truth for ProjectOps task state
- the owner of `.projectops` files
- a direct SQLite mutator
- a bypass around `ProjectOpsServiceAdapter`
- an automatic verifier of Codex results
- an automatic memory applier

## Recommended Integration Shape

Future flow:

```text
OpenClaw message
-> OpenClawMessage wrapper
-> OpenClawAdapter
-> AdapterSession.handle_text
-> if pending_confirmation, ask user
-> user confirms or rejects
-> AdapterSession.confirm or AdapterSession.reject
-> event_from_turn_result
-> render_event_as_text(style="chat")
-> OpenClaw response message
```

The local adapter pipeline remains the ProjectOps-facing boundary. OpenClaw is
only the channel-specific wrapper around that boundary.
The local channel adapter contract and smoke flow are documented in
[channel_adapter_contract.md](channel_adapter_contract.md).
The advisory adapter permission policy is documented in
[adapter_permission_policy.md](adapter_permission_policy.md).

## Proposed Message Wrapper

Future conceptual model: `OpenClawMessage`

Fields:

- `channel_id`
- `user_id`
- `message_id`
- `text`
- `timestamp`
- `thread_id` optional
- `reply_to_message_id` optional
- `metadata` dict

This is a design model only. It does not need to match the OpenClaw runtime
exactly yet. A future adapter should normalize OpenClaw-specific payloads into
this shape before routing them into ProjectOps.

## Payload Normalization

The current skeleton includes a local payload normalization layer. It is still
not real OpenClaw integration, and it does not import OpenClaw or call OpenClaw
APIs.

`normalize_openclaw_message_payload` converts generic external or OpenClaw-like
payload dictionaries into `OpenClawMessage`. It supports aliases for common
field names while preserving the internal canonical model.

Required normalized fields:

- `channel_id`
- `user_id`
- `message_id`
- `text`
- `timestamp`

Supported examples include `channelId` for `channel_id`, `userId` for
`user_id`, `messageId` for `message_id`, `content` for `text`, and `createdAt`
for `timestamp`. Optional fields include `thread_id`,
`reply_to_message_id`, and `metadata`.

`OpenClawAdapter.handle_payload` is a convenience skeleton method for raw
dictionary payloads:

```text
OpenClaw-like payload dict
-> normalize_openclaw_message_payload
-> OpenClawMessage
-> OpenClawAdapter.handle_message
-> OpenClawResponse
-> openclaw_response_to_payload
-> JSON-safe payload dict
```

Normalization failures return a JSON-safe error payload from `handle_payload`
instead of exposing a Python stack trace. If `channel_id` cannot be normalized,
the skeleton uses `"unknown"` as a placeholder channel value in that error
payload.

Real OpenClaw payload mapping may change after checking the actual OpenClaw
runtime API. ProjectOps still owns task state; OpenClaw-like payloads are only
message inputs.

## Proposed Response Wrapper

Future conceptual model: `OpenClawResponse`

Fields:

- `channel_id`
- `thread_id` optional
- `reply_to_message_id` optional
- `text`
- `event_type`
- `request_id`
- `requires_confirmation`
- `metadata` dict

Rendered text should come from the `AdapterEvent` renderer, usually
`render_event_as_text(style="chat")`. The response should preserve `request_id`
for confirmation flow. The response should not expose raw internal exceptions.

## Session Ownership Policy

The session ownership policy defines how OpenClaw-facing conversations map to
`AdapterSession` instances.

Recommended session key:

- `channel_id + user_id`

Optional thread-aware key:

- `channel_id + user_id + thread_id`

Tradeoff:

- user-level sessions are simpler
- thread-level sessions reduce cross-task confusion
- future implementation should start with `channel_id + user_id + thread_id`
  when `thread_id` exists

Pending confirmations are currently in-memory only. The skeleton uses the
reusable `AdapterSessionStore` behavior through `OpenClawSessionStore`, which
stores `AdapterSession` objects and latest pending request IDs by session key.
A future OpenClaw adapter may need a persistent session store, but that should
be explicit future work. ProjectOps task state remains in `.projectops` and
SQLite, not OpenClaw memory.

## Permission And Mutation Policy

Read-only, no confirmation required:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Safe mutating, confirmation required:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `propose_memory_update`

Sensitive mutating, explicit confirmation required:

- `attach_result`
- `verify_task`
- `create_final_report`

Future high-risk operations should require stronger policy before
implementation:

- auto-running Codex
- applying memory diffs
- repairing workspace state
- deleting artifacts
- editing task history
- deployment
- external API actions

The future OpenClaw adapter must not execute mutating actions without
confirmation. It must not auto-verify tasks. It must not auto-apply memory
proposals. It must preserve user control.

The current permission policy module is advisory only. A future OpenClaw
adapter can use it as an enforcement layer to distinguish read-only actions,
safe mutations, sensitive mutations, future high-risk actions, and unknown
actions before routing requests into `AdapterSession`.

## Confirmation Flow

Example:

```text
User:
create task Investigate auth bug

Adapter:
maps to create_task
detects requires_confirmation
stores pending request_id
responds with confirmation prompt

User:
yes

Adapter:
calls AdapterSession.confirm(request_id)
executes confirmed request
renders result

User:
no

Adapter:
calls AdapterSession.reject(request_id)
does not execute
```

Ambiguous `yes` or `no` without a pending request should produce a helpful
error. `request_id` should be included in rendered confirmation messages when
useful. A future UI may use buttons, but text confirmation must remain possible.

## Channel-Specific Rendering Policy

Initial default:

- `render_event_as_text(style="chat")`
- future OpenClaw adapter code should prefer
  `render_event_for_channel(event, channel="openclaw")`

For logs:

- `render_event_as_text(style="log")`

Future channel-specific policies:

- OpenClaw chat: concise chat style
- Slack: chat style, possibly markdown-safe later
- Telegram: short chat style
- logs: log style
- web UI: consume `AdapterEvent` directly, not rendered text

The renderer should not hide errors. The renderer should not expose unnecessary
absolute paths. Renderer output is presentation only. Task state must be read
from ProjectOps, not inferred from rendered text.

The channel rendering policy is local-only. It does not import OpenClaw, call
OpenClaw APIs, or send messages.

## Error Handling Policy

Future OpenClaw adapters should handle:

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

Rules:

- show clean user-facing errors
- do not expose stack traces
- include next suggested action when possible
- preserve `request_id` when possible
- doctor errors should be shown clearly, not hidden

## ProjectOps Source Of Truth

`.projectops` files and SQLite are the source of truth for task state.
`AdapterSession` is in-memory interaction state only. `AdapterEvent` is
renderable event state only. OpenClaw messages are communication records only.
OpenClaw should not be used as the primary task database.

## Minimal Future Module Sketch

Current placeholder package:

```text
src/projectops/adapters/openclaw/
  __init__.py
  models.py
  adapter.py
  normalization.py
  session_store.py
```

## Current Skeleton Implementation

`src/projectops/adapters/openclaw/` contains placeholder models and a local
adapter skeleton. It does not import real OpenClaw. It does not call OpenClaw
APIs. It proves the local flow:
The skeleton does not call OpenClaw APIs.

```text
OpenClawMessage
-> OpenClawAdapter
-> AdapterSession
-> AdapterTurnResult
-> AdapterEvent
-> render_event_as_text(style="chat")
-> OpenClawResponse
```

The skeleton uses the reusable in-memory session store abstraction only. It is
not a production OpenClaw integration.

Current responsibilities:

`models.py`:

- `OpenClawMessage`
- `OpenClawResponse`

`normalization.py`:

- normalize raw OpenClaw-like payload dictionaries to `OpenClawMessage`
- convert `OpenClawResponse` values back to JSON-safe payload dictionaries
- return clean normalization error payloads for `handle_payload`

`adapter.py`:

- route placeholder `OpenClawMessage` values through `AdapterSession`
- route raw payload dictionaries through `handle_payload`
- route through `AdapterSession`
- convert `AdapterTurnResult` to `AdapterEvent`
- render response

`session_store.py`:

- OpenClaw-facing subclass of the generic `AdapterSessionStore`
- in-memory `AdapterSession` and pending request tracking

Future production integration may split channel-specific rendering into a
separate `renderer.py` and replace or extend `session_store.py` with a
persistent store.

For the end-to-end local skeleton flow from raw payload normalization through
`OpenClawResponse` payload output, see
[channel_adapter_contract.md](channel_adapter_contract.md).

## Minimal Future Tests

Future implementation tests should cover:

- read-only message returns response
- mutating message creates pending confirmation
- yes confirms pending action
- no rejects pending action
- missing pending confirmation returns clean error
- errors are rendered safely
- session key prevents cross-user confirmation leakage
- no direct `.projectops` mutation outside service adapter

## Non-Goals

- no OpenClaw integration yet
- no server
- no webhook listener
- no auth implementation
- no persistent session store
- no Codex auto-execution
- no external APIs
- no deployment
- no UI components

## Future Work

- PHASE 10-B: OpenClaw adapter skeleton without real OpenClaw import
- PHASE 10-C: OpenClaw-like payload normalization
- PHASE 10-D: session store abstraction
- PHASE 10-E: permission policy module
- PHASE 10-F: channel-specific renderer policy
- later: real OpenClaw integration after checking actual OpenClaw runtime API
