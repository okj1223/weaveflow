# Channel Adapter Contract

## Purpose

This document ties together the local adapter pipeline for future channel
integrations such as OpenClaw, Slack, Telegram, terminal tools, or automation
scripts.

This is not real OpenClaw integration. This is not a server API. This is not a
network protocol. This is not a bot. This is a local Python adapter contract
and smoke flow. Future channel integrations should use this contract rather
than directly editing `.projectops` files.

## Current Local Channel Adapter Flow

```text
Raw external payload
-> normalize_openclaw_message_payload
-> OpenClawMessage
-> OpenClawAdapter.handle_message
-> AdapterSession
-> ProjectOpsServiceAdapter
-> AdapterTurnResult
-> AdapterEvent
-> render_event_for_channel
-> OpenClawResponse
-> openclaw_response_to_payload
```

Stage responsibilities:

- Raw external payload: a channel-specific message dictionary received from a
  future adapter boundary.
- `normalize_openclaw_message_payload`: validates and converts the dictionary
  into the internal placeholder `OpenClawMessage`.
- `OpenClawMessage`: carries normalized channel, user, message, text, timestamp,
  thread, reply, and metadata fields.
- `OpenClawAdapter.handle_message`: owns the local channel flow and routes the
  normalized message into session handling.
- `AdapterSession`: handles text mapping, pending confirmation state, and
  execution through the service adapter.
- `ProjectOpsServiceAdapter`: calls ProjectOps service functions and enforces
  mutation gating.
- `AdapterTurnResult`: records the session turn state, response, and error
  fields.
- `AdapterEvent`: converts the turn into a JSON-safe renderable event.
- `render_event_for_channel`: adapts event text for a named channel such as
  `openclaw` or `log`.
- `OpenClawResponse`: carries the placeholder channel response model.
- `openclaw_response_to_payload`: converts the response into a JSON-safe
  dictionary.

## Recommended Future OpenClaw Flow

```text
OpenClaw runtime payload
-> OpenClaw-specific adapter wrapper
-> normalize payload to OpenClawMessage
-> session key from channel_id + user_id + thread_id
-> AdapterSession handles text and confirmations
-> response converted to AdapterEvent
-> render_event_for_channel(channel="openclaw")
-> send response back to OpenClaw user
```

OpenClaw should be the channel surface only. ProjectOps remains the source of
truth. `.projectops` files and SQLite remain the task state authority.
`AdapterSession` state is interaction state only.

## Permission Policy Placement

The adapter permission policy belongs between intent mapping and execution in a
future channel adapter.

Current state:

- `permissions.py` is advisory.
- Existing runtime behavior is unchanged.
- Future OpenClaw adapter code should consult the permission policy before
  executing or confirming sensitive actions.

Recommended future behavior:

- `read_only` actions execute immediately.
- `safe_mutation` actions require confirmation.
- `sensitive_mutation` actions require explicit confirmation.
- `future_high_risk` actions are blocked until a stronger policy exists.

## Confirmation And Session Ownership

Pending confirmations are stored by session key. The default session key should
be `channel_id + user_id + thread_id` when `thread_id` exists, and
`channel_id + user_id` otherwise.

`yes` and `no` should only affect pending requests in the same session. Pending
session state is currently in-memory only. A future persistent session store
should be explicit future work.

## Channel Rendering Policy

`render_event_for_channel` chooses formatting for `openclaw`, `slack`,
`telegram`, `terminal`, and `log`. A future OpenClaw adapter should use
`render_event_for_channel(event, channel="openclaw")`.

Rendered text is presentation only and must not be treated as source of truth.
Renderers should not hide errors. Absolute path redaction is intentionally
simple and is not a full secret redaction system.

## Error Handling Contract

- Normalization errors produce safe payloads.
- Intent errors become `AdapterTurnResult` values with `state: error`.
- Adapter errors become `AdapterResponse` values with `ok: false`.
- Event conversion should preserve errors.
- Renderers should show clean error text.
- Raw stack traces should not be shown to users.

Important error types:

- `OpenClawPayloadNormalizationError`
- `EmptyIntent`
- `UnknownIntent`
- `InvalidIntent`
- `MutationNotAllowed`
- `UnsupportedAction`
- `PendingConfirmationNotFound`
- `WorkspaceNotFoundError`
- `TaskNotFoundError`
- `MissingPlanError`
- `MissingResultFileError`
- `InvalidVerificationStatusError`

## Source Of Truth

`.projectops` files and SQLite are the source of truth for task state.
`AdapterSessionStore` is not task storage. OpenClaw payloads are not task
storage. `AdapterEvent` values are renderable records only. Channel messages are
communication artifacts only.

## Minimal Local Smoke Flow

`examples/channel_adapter_flow_demo.py` demonstrates the local channel adapter
contract without touching the real repository workspace.

The demo shows:

- status before init
- init workspace pending
- `yes` confirms init
- create task pending
- `yes` confirms create task
- list tasks
- doctor
- bad payload normalization error
- channel rendering for `openclaw` and `log`

Run it with:

```bash
python3 examples/channel_adapter_flow_demo.py
```

## Non-Goals

- no real OpenClaw integration
- no server
- no webhook listener
- no auth runtime
- no authorization runtime
- no persistent session store
- no external APIs
- no bot runtime
- no auto-running Codex
- no memory auto-apply
- no repair automation

## Future Work

- real OpenClaw runtime API research
- OpenClaw payload adapter implementation
- persistent session store design
- explicit permission enforcement
- channel-specific markdown policy
- auth and user identity mapping
- safe Codex execution policy
- worker execution queue
