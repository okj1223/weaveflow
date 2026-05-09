# Adapter Renderer Policy

## Purpose

Renderer helpers convert `AdapterEvent` and `AdapterTranscript` values into
plain text for future external UIs. The output is suitable for chat surfaces,
logs, OpenClaw messages, Slack messages, Telegram messages, terminal logs, or
simple UI previews.

## Non-Goals

- This is not OpenClaw integration.
- This is not a server.
- This does not call external APIs.
- This does not execute actions.
- This does not persist transcripts.
- This does not define rich UI components.

## Rendering Flow

```text
AdapterSession
-> AdapterTurnResult
-> AdapterEvent
-> render_event_as_text
-> external UI message
```

Renderers only format existing adapter events. They do not call
`ProjectOpsServiceAdapter`, mutate the workspace, or inspect ProjectOps files.

## Styles

`render_event_as_text(event, style="chat")` supports:

- `chat`: concise user-facing text for chat-like surfaces.
- `log`: single-line, machine-friendly text for logs.

`render_transcript_as_text(transcript, style="chat")` renders events in order
with a transcript header and event count.

Unknown styles raise `ValueError`.

## Safety Rules

- Rendered text is not source of truth.
- ProjectOps files and SQLite remain the source of truth.
- Renderers must not mutate the workspace.
- Renderers must not hide errors.
- Renderers should avoid leaking unnecessary absolute local paths.
- Renderers must not expose stack traces.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw message
-> AdapterSession.handle_text
-> event_from_turn_result
-> render_event_as_text(style="chat")
-> send message back to OpenClaw user
```

OpenClaw should use rendered text for presentation only and keep state changes
routed through `ProjectOpsServiceAdapter`.

## Examples

Completed event:

```text
✅ Completed: status
Adapter action succeeded: status
Workspace exists: false
```

Pending confirmation:

```text
⚠️ Confirmation required: create_task
Confirm mutating action: create_task
Request ID: req-123. Confirm or reject this request in the external UI.
```

Rejected event:

```text
🚫 Rejected: create_task
Rejected adapter action: create_task
Request ID: req-123
```

Error event:

```text
❌ Error: UnknownIntent
UnknownIntent: Could not map command: unknown nonsense
Request ID: req-123
```

Transcript rendering:

```text
Adapter transcript: session-1
Event count: 2
[INFO] completed event_type=turn_completed action=status request_id=req-status
[WARN] pending_confirmation event_type=pending_confirmation action=create_task request_id=req-task
```

## Demo

Run the local demo with:

```bash
python3 examples/adapter_renderer_demo.py
```
