# Adapter Intent Mapping

## Purpose

The adapter intent mapper translates simple external text commands into
`AdapterRequest` objects. It is a deterministic intake layer for future external
interfaces such as OpenClaw, Slack, Telegram, desktop UI, web UI, or automation
scripts.

## Non-Goals

- This is not OpenClaw integration.
- This is not an LLM intent parser.
- This is not a server.
- This does not call external APIs.
- This does not execute actions.
- This does not mutate workspace state.

## Safety Model

The mapper only maps. It does not call `ProjectOpsServiceAdapter`, does not call
service functions, and does not write files.

Mutating actions require `allow_mutation=True` to be executed by
`ProjectOpsServiceAdapter`. If `allow_mutation` is false, mutating commands map
successfully but return `requires_confirmation: true`. Future OpenClaw adapters
should use that flag to ask for confirmation before executing the request.

## Supported Commands

Read-only commands:

- `status`, `/status`, `workspace status`, `show status`
- `tasks`, `/tasks`, `list tasks`, `task list`, `show tasks`
- `doctor`, `/doctor`, `check health`, `workspace health`, `health`
- `show TASK-0001`, `show task TASK-0001`, `task TASK-0001`

Mutating commands:

- `init`, `/init`, `init workspace`, `initialize workspace`
- `create task Investigate auth bug`
- `new task Add adapter mapper tests`
- `task create Write README section`
- `plan TASK-0001`, `create plan TASK-0001`, `plan task TASK-0001`
- `brief TASK-0001`, `brief TASK-0001 codex`
- `create brief TASK-0001`, `create codex brief TASK-0001`
- `worker brief TASK-0001`
- `attach TASK-0001 path/to/result.md`
- `attach result TASK-0001 path/to/result.md`
- `verify TASK-0001 passed manual check`
- `verify task TASK-0001 failed manual check`
- `report TASK-0001`, `final report TASK-0001`, `create report TASK-0001`
- `memory propose TASK-0001`, `propose memory TASK-0001`, `memory TASK-0001`

Task IDs are matched case-insensitively and normalized to uppercase.

## Future OpenClaw Usage

Recommended future flow:

```text
OpenClaw message
-> map_text_to_adapter_request
-> if requires_confirmation, ask user
-> ProjectOpsServiceAdapter.handle
-> render AdapterResponse
```

OpenClaw should not mutate `.projectops/` files directly and should not parse
human-readable CLI output.

## Confirmation flow

Mutating commands map with `requires_confirmation: true` when
`allow_mutation` is false. External adapters can use the confirmation helper to
make that flow explicit:

1. Call `prepare_confirmation(text)`.
2. If confirmation is required, ask the user.
3. If the user confirms, call `confirm_request(state)` and then pass the
   confirmed request to `ProjectOpsServiceAdapter.handle`.
4. If the user rejects, call `reject_request(state)` and do not execute.

This flow is deterministic. It does not use OpenClaw, does not use an LLM, and
does not execute actions until an external caller passes a confirmed request to
the adapter.

## Error Behavior

Mapping failures return an `IntentMappingResult` with `ok: false` and no
`AdapterRequest`.

- `EmptyIntent`: empty or whitespace-only command.
- `UnknownIntent`: command does not match a supported deterministic pattern.
- `InvalidIntent`: command matches a known pattern but is missing required data
  or uses an invalid value.

## Example

```python
from pathlib import Path

from projectops.adapters import ProjectOpsServiceAdapter
from projectops.adapters.intent_mapper import map_text_to_adapter_request

root = Path(".")
result = map_text_to_adapter_request("status")
if result.request is not None:
    response = ProjectOpsServiceAdapter(root).handle(result.request)
    print(response.ok, response.data)
```

## Demo

Run the local demo with:

```bash
python3 examples/adapter_intent_mapping_demo.py
```

The demo uses `TemporaryDirectory` and does not modify the repository's real
ProjectOps workspace.
