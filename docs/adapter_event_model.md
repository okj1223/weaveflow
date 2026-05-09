# Adapter Event Model

## Purpose

`AdapterEvent` and `AdapterTranscript` provide a stable local event model for
future external UIs. They let OpenClaw, Slack, Telegram, desktop UI, web UI, or
automation scripts render ProjectOps adapter session turns without interpreting
internal Python objects directly.

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

## Event Types

- `turn_completed`: a turn completed successfully.
- `pending_confirmation`: a mutating command is waiting for user confirmation.
- `turn_rejected`: a pending confirmation was rejected.
- `turn_error`: a turn failed or could not be mapped.

Event levels are `info`, `warning`, or `error`.

## Safety

- Events are read-only representations.
- Events do not mutate the ProjectOps workspace.
- Events are not persisted by this helper.
- Events should not be treated as the source of truth.
- ProjectOps files and SQLite remain the source of truth for task state.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw message
-> AdapterSession.handle_text
-> AdapterTurnResult
-> event_from_turn_result
-> render AdapterEvent to user
```

OpenClaw should render the event and keep ProjectOps state changes routed
through `ProjectOpsServiceAdapter`.

## Example

```python
from pathlib import Path

from projectops.adapters import (
    AdapterSession,
    ProjectOpsServiceAdapter,
    event_from_turn_result,
)

session = AdapterSession(ProjectOpsServiceAdapter(Path(".")))
turn = session.handle_text("status")
event = event_from_turn_result(turn)

print(event.event_type, event.level, event.message)
```

## Demo

Run the local demo with:

```bash
python3 examples/adapter_event_demo.py
```

The demo uses `TemporaryDirectory` and does not modify the repository's real
ProjectOps workspace.
