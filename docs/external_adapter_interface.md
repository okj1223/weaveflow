# External Adapter Interface

## Purpose

This document defines how external adapters should interact with ProjectOps
Kernel without depending on human-readable CLI output.

Human-readable CLI output is for humans. JSON CLI output and Python service
functions are for adapters. External adapters should not parse human-readable
text, and they should not directly mutate `.projectops/` files unless that
behavior is explicitly designed through ProjectOps service functions.

ProjectOps Kernel remains local-first and file-based. An adapter may provide a
channel surface, user interface, or automation wrapper, but ProjectOps remains
the source of truth for workspace state.

## Adapter Responsibilities

An adapter is responsible for:

- Receiving user input from an external surface.
- Mapping that input to supported ProjectOps operations.
- Calling ProjectOps through either Python service functions or CLI JSON
  commands.
- Rendering results back to the user.
- Showing clean errors.
- Preserving ProjectOps state integrity.
- Avoiding unexpected destructive actions.
- Avoiding invented task state.
- Avoiding validation bypasses.

Python service functions are preferred for in-process adapters. CLI JSON
commands are acceptable for shell-based adapters.

## Kernel Responsibilities

ProjectOps Kernel is responsible for:

- Workspace initialization.
- Task creation.
- Task planning.
- Worker brief generation.
- Artifact attachment.
- Manual verification record creation.
- Final report generation.
- Memory proposal generation.
- Task listing.
- Workspace diagnostics.
- JSON contract output.
- Status consistency between YAML and SQLite.

## Adapter Non-Goals

Adapters should not:

- Bypass `service.py` to modify SQLite directly.
- Parse human-readable CLI output.
- Auto-run Codex without an explicit future execution policy.
- Auto-apply memory diffs.
- Auto-repair doctor errors.
- Auto-delete task artifacts.
- Silently change task status.
- Hide verification failures.
- Treat warnings as success without reporting them.
- Expose secrets or credentials.
- Perform destructive filesystem actions without explicit approval.

## Integration Modes

### Mode A: Python Service Mode

An in-process adapter should import ProjectOps service functions:

```python
from pathlib import Path

from projectops import service
from projectops.errors import ProjectOpsError

root = Path.cwd()

try:
    status = service.get_status(root)
except ProjectOpsError as error:
    render_error(str(error))
```

Supported service functions include:

- `init_workspace(root)`
- `get_status(root)`
- `create_task(root, user_request)`
- `show_task(root, task_id)`
- `create_plan(root, task_id)`
- `create_worker_brief(root, task_id, worker="codex")`
- `attach_result(root, task_id, result_path)`
- `verify_task(root, task_id, status, note)`
- `create_final_report(root, task_id)`
- `propose_memory_update(root, task_id)`
- `list_tasks(root)`
- `doctor_workspace(root)`

This mode is preferred for adapters running in the same Python environment. It
receives structured Python objects or dictionaries and should catch
`ProjectOpsError` subclasses for normal workflow errors.

### Mode B: CLI JSON Mode

A shell-based adapter may call:

- `ops status --json`
- `ops task list --json`
- `ops doctor --json`

This mode is useful for simple scripts or tools that do not import Python code.
Adapters using CLI JSON mode must validate `contract_version`, should validate
against schemas when feasible, and must not parse human-readable output.

For now, only status, task list, and doctor have JSON output.

## Current Machine-Readable Commands

| Command | Purpose | Exit behavior | Schema | Version | Before `ops init` | Mutates workspace |
| --- | --- | --- | --- | --- | --- | --- |
| `ops status --json` | Read workspace status and task summaries. | Exits `0`, including before init. | `schemas/status.schema.json` | `projectops.v1` | Returns `workspace_exists: false`. | No |
| `ops task list --json` | Read all indexed tasks. | Exits non-zero if the workspace is missing. | `schemas/task_list.schema.json` | `projectops.v1` | Fails cleanly. | No |
| `ops doctor --json` | Diagnose workspace health. | Exits `0` when healthy or warnings-only; exits `1` when errors exist. | `schemas/doctor.schema.json` | `projectops.v1` | Prints valid JSON with an error check. | No |

`ops doctor --json` is read-only. It reports errors and warnings but does not
repair anything.

## Adapter Command Mapping

| User intent | Adapter action | Safety |
| --- | --- | --- |
| Show workspace status | Call `get_status(root)` or `ops status --json`. | Read-only |
| List tasks | Call `list_tasks(root)` or `ops task list --json`. | Read-only |
| Check workspace health | Call `doctor_workspace(root)` or `ops doctor --json`. | Read-only |
| Create a task | Call `create_task(root, user_request)`. | Mutates workspace, but safe |
| Generate a plan | Call `create_plan(root, task_id)`. | Mutates task files and status |
| Generate Codex brief | Call `create_worker_brief(root, task_id, worker="codex")`. | Mutates task files and status |
| Attach result | Call `attach_result(root, task_id, result_path)`. | Copies file and mutates status |
| Verify task | Call `verify_task(root, task_id, status, note)`. | Status-changing; should be explicit |
| Create final report | Call `create_final_report(root, task_id)`. | Status-changing if verified |
| Propose memory update | Call `propose_memory_update(root, task_id)`. | Proposal only; does not apply global memory |

## Error Handling Policy

Python adapters should catch `ProjectOpsError` from `projectops.errors`. Known
normal workflow errors include:

- `WorkspaceNotFoundError`
- `TaskNotFoundError`
- `MissingPlanError`
- `MissingResultFileError`
- `UnsupportedWorkerError`
- `InvalidVerificationStatusError`

CLI adapters should use exit codes and stdout or stderr behavior. Normal user
errors should be rendered clearly, and adapters should not show raw Python stack
traces to end users.

## State Mutation Policy

Read-only operations:

- `get_status`
- `list_tasks`
- `doctor_workspace`
- `ops status --json`
- `ops task list --json`
- `ops doctor --json`

Workspace-mutating operations:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `attach_result`
- `verify_task`
- `create_final_report`
- `propose_memory_update`

High-risk or future-gated operations:

- Auto-running Codex.
- Applying memory diffs.
- Repairing workspace state.
- Deleting artifacts.
- Editing task history.
- Deployment or external API actions.

## External Adapter Safety Rules

- Always check `contract_version` for JSON payloads.
- Treat unknown `contract_version` values as unsupported.
- Prefer service functions over direct file edits.
- Do not parse human-readable CLI output.
- Do not assume task IDs; read returned IDs.
- Do not silently retry mutating operations without reporting.
- Do not auto-verify tasks.
- Do not auto-complete tasks without verification.
- Do not hide doctor errors.
- Use the confirmation helper for mutating text-command intents.
- Do not expose absolute local paths to external users unless intended.
- Preserve user control for destructive or irreversible actions.

## Internal Adapter Skeleton

`ProjectOpsServiceAdapter` is the current internal adapter boundary. It is not
OpenClaw integration yet, and it does not create a bot, server, network
listener, or autonomous worker.

The adapter accepts an `AdapterRequest` and returns an `AdapterResponse`.
The response contract is documented in
[adapter_response_contract.md](adapter_response_contract.md). Future OpenClaw
adapters should consume `AdapterResponse` instead of inventing a separate
response format.
The local demo in `examples/adapter_usage_demo.py` is documented in
[adapter_usage_examples.md](adapter_usage_examples.md).
The deterministic text intake prototype is documented in
[adapter_intent_mapping.md](adapter_intent_mapping.md).
The in-memory confirmation/session prototype is documented in
[adapter_session_lifecycle.md](adapter_session_lifecycle.md).
Read-only actions are:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Mutating actions require `allow_mutation=True`:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `attach_result`
- `verify_task`
- `create_final_report`
- `propose_memory_update`

Future OpenClaw adapters should call this adapter or the service functions
instead of mutating files, SQLite, or task state directly.

```python
from pathlib import Path
from projectops.adapters import AdapterRequest, ProjectOpsServiceAdapter

adapter = ProjectOpsServiceAdapter(Path("."))

response = adapter.handle(AdapterRequest(action="status"))
print(response.ok)
print(response.data)

response = adapter.handle(
    AdapterRequest(
        action="create_task",
        params={"user_request": "Investigate auth bug"},
        allow_mutation=True,
    )
)
print(response.data)
```

## Recommended OpenClaw Integration Shape

This section describes a future shape only. It does not implement OpenClaw.

OpenClaw should act as:

- Channel surface.
- User interaction layer.
- Command intake layer.
- Notification surface.

OpenClaw should not be:

- The source of truth for ProjectOps state.
- The owner of task files.
- The direct SQLite mutator.
- The verifier of Codex results without ProjectOps verification records.

Recommended future flow:

```text
OpenClaw message
-> OpenClaw adapter parses intent
-> adapter prepares confirmation for mutating commands
-> adapter carries pending confirmation state with AdapterSession if needed
-> adapter calls ProjectOps service function
-> ProjectOps writes task/artifact/status files
-> adapter returns concise status/report to OpenClaw user
```

## Minimal Future Adapter Skeleton Preview

A future adapter package could look like this:

```text
src/projectops/adapters/
  __init__.py
  base.py
  service_adapter.py
```

A possible `BaseAdapter` could be responsible for:

- Handling an input message.
- Calling service functions.
- Rendering a response.
- Handling `ProjectOpsError`.
- Enforcing read-only versus mutating operation policies.

This skeleton is only a preview. Phase 9-A does not implement adapter runtime
code.
