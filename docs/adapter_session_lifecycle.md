# Adapter Session Lifecycle

## Purpose

`AdapterSession` carries pending confirmation state across future external
adapter turns. It is a small in-memory helper for flows where a user sends one
message that maps to a mutating action, then confirms or rejects that action in
a later turn.

## Non-Goals

- This is not OpenClaw integration.
- This is not a server.
- This does not persist sessions.
- This does not call external APIs.
- This does not auto-run Codex.

## Session Flow

`AdapterSession.handle_text(text)` accepts external-style text and uses the
deterministic intent mapper plus the confirmation helper.

- Read-only commands execute immediately and return `state: completed`.
- Mutating commands return `state: pending_confirmation` unless
  `allow_mutation=True` is passed.
- `confirm(request_id)` confirms a pending request, executes it through
  `ProjectOpsServiceAdapter`, removes it from pending state, and returns a
  completed or error result.
- `reject(request_id)` removes the pending request and returns `state:
  rejected` without executing it.
- Missing or invalid commands return `state: error`.

Pending confirmations are keyed by `request_id`. If a caller does not provide a
request ID, the session generates one.

## Safety Model

- Mutating actions are not executed before confirmation.
- Pending state is in-memory only.
- External adapters must decide how to persist or rehydrate state later if they
  need that behavior.
- ProjectOps state changes only through `ProjectOpsServiceAdapter`.
- The session does not call external APIs, run background workers, or silently
  confirm requests.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw message
-> AdapterSession.handle_text
-> if pending_confirmation, ask user
-> user confirms
-> AdapterSession.confirm(request_id)
-> render AdapterTurnResult
```

OpenClaw should treat the session as a local helper, not as a source of truth.
If OpenClaw needs durable cross-process state later, that should be designed as
a separate explicit adapter feature.

## Example

```python
from pathlib import Path

from projectops.adapters import AdapterSession, ProjectOpsServiceAdapter

session = AdapterSession(ProjectOpsServiceAdapter(Path(".")))

turn = session.handle_text("init workspace", request_id="req-init")
if turn.state == "pending_confirmation":
    # Ask the user before mutating ProjectOps state.
    turn = session.confirm("req-init")

print(turn.ok, turn.state)
```

## Demo

Run the local demo with:

```bash
python3 examples/adapter_session_demo.py
```

The demo uses `TemporaryDirectory` and does not modify the repository's real
ProjectOps workspace.
