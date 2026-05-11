# Adapter Event Model

## Purpose

`AdapterEvent` and `AdapterTranscript` provide a stable local event model for
future external UIs. They let OpenClaw, Slack, Telegram, desktop UI, web UI, or
automation scripts render Weaveflow adapter session turns without interpreting
internal Python objects directly.

For how events fit into the full adapter pipeline, see
[adapter_pipeline_contract.md](adapter_pipeline_contract.md).

## Non-Goals

- This is not OpenClaw integration.
- This is not a server.
- This does not persist events.
- This does not call external APIs.
- This does not execute actions.

## Event Lifecycle

`AdapterSession` produces an `AdapterTurnResult`. A caller can convert that turn
into an `AdapterEvent` with `event_from_turn_result`. Multiple events can be
grouped into an `AdapterTranscript`.

```text
AdapterSession.handle_text(...)
-> AdapterTurnResult
-> event_from_turn_result(...)
-> AdapterEvent
-> AdapterTranscript
```

Future UIs can render `AdapterEvent` values without knowing the internal
session, confirmation, or service adapter model details.

For plain-text presentation, use `render_event_as_text`. The renderer policy is
documented in [adapter_renderer_policy.md](adapter_renderer_policy.md).

## Event Types

- `turn_completed`: a turn completed successfully.
- `pending_confirmation`: a mutating command is waiting for user confirmation.
- `turn_rejected`: a pending confirmation was rejected.
- `turn_error`: a turn failed or could not be mapped.

Event levels are `info`, `warning`, or `error`.

## Safety

- Events are read-only representations.
- Events do not mutate the Weaveflow workspace.
- Events are not persisted by this helper.
- Events should not be treated as the source of truth.
- Weaveflow files and SQLite remain the source of truth for task state.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw message
-> AdapterSession.handle_text
-> AdapterTurnResult
-> event_from_turn_result
-> render AdapterEvent to user
```

OpenClaw should render the event and keep Weaveflow state changes routed
through `WeaveflowServiceAdapter`.

## Example

```python
from pathlib import Path

from weaveflow.adapters import (
    AdapterSession,
    WeaveflowServiceAdapter,
    event_from_turn_result,
)

session = AdapterSession(WeaveflowServiceAdapter(Path(".")))
turn = session.handle_text("status")
event = event_from_turn_result(turn)

print(event.event_type, event.level, event.message)
```

To render that event for a chat-like surface:

```python
from weaveflow.adapters import render_event_as_text

print(render_event_as_text(event, style="chat"))
```

## Demo

Run the local demo with:

```bash
python3 examples/adapter_event_demo.py
```

The demo uses `TemporaryDirectory` and does not modify the repository's real
Weaveflow workspace.
