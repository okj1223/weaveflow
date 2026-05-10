# ProjectOps Kernel

ProjectOps Kernel is a local-first workflow system MVP.

It provides a Python CLI named `ops` that turns a user request into a structured
task workspace. Each task is represented by human-readable files such as a task
spec, plan, Codex worker brief, artifacts, verification record, final report,
and proposed memory update.

## What This Project Is

- A small, file-based workflow kernel for project operations.
- A local CLI for creating, planning, briefing, verifying, and reporting tasks.
- A way to generate `worker_brief_codex.md` files that can be manually copied
  into Codex.
- A SQLite-backed index for task IDs, titles, statuses, timestamps, and task
  directories.
- A Python service boundary in `projectops.service` that external interfaces
  can call without going through Typer.
- A testable Python package built with Typer, Pydantic, PyYAML, SQLite, and
  pytest.

## What This Project Is Not

- It is not a chatbot.
- It is not a thin Codex wrapper.
- It does not control Codex automatically.
- It does not call the OpenAI API.
- It does not integrate OpenClaw yet.
- It does not expose network, bot, desktop, or web adapters yet.
- It does not run autonomous agents.
- It does not implement vector memory.
- It does not provide a web UI.
- It does not orchestrate multiple workers.

The MVP intentionally keeps Codex interaction manual: `ops task brief` generates
a `worker_brief_codex.md` file, and a developer copies that brief into Codex.
The result from Codex is then attached back to the task as an artifact.

## MVP Workflow

```text
User request
-> ops task create
-> ops task plan
-> ops task brief
-> paste worker_brief_codex.md into Codex
-> attach Codex result
-> verify
-> report
-> propose memory update
```

The workflow produces this task record:

```text
task_spec.yaml
plan.yaml
worker_brief_codex.md
artifacts/
artifacts.yaml
verification_record.yaml
final_report.md
memory_diff.md
```

## Installation

Use Python 3.11 or newer.

```bash
python3.11 -m pip install -e ".[dev]"
```

Run tests with:

```bash
python3.11 -m pytest
```

If your local machine uses `python` or `python3` for Python 3.11+, those commands
are fine too.

## CLI Commands

Initialize and inspect the workspace:

```bash
ops init
ops status
ops status --json
ops doctor
ops doctor --json
```

Create and inspect tasks:

```bash
ops task create "USER REQUEST"
ops task show TASK-0001
ops task list
ops task list --json
```

`ops task list` reads from SQLite and prints one row per task with id, status,
title, `created_at`, and `updated_at`:

```text
TASK-0001 | completed | Example title | 2026-05-09T... | 2026-05-09T...
```

`ops status --json`, `ops task list --json`, and `ops doctor --json` provide
machine-readable output for scripts and future adapters. The default output is
still human-readable.

The JSON contracts are documented in [docs/adapter_contracts.md](docs/adapter_contracts.md)
and validated by schemas in [schemas/](schemas/). Current JSON outputs use
`contract_version: "projectops.v1"`.
Future adapter expectations are documented in
[docs/external_adapter_interface.md](docs/external_adapter_interface.md).

## Repository Hygiene

ProjectOps is local-first, so `.projectops/` contains runtime workspace state.
Source code, tests, docs, schemas, and reviewed examples should be version
controlled. Local task history, SQLite state, and workspace memory are ignored
by default unless deliberately preserved elsewhere.

See [docs/repository_hygiene.md](docs/repository_hygiene.md) for the commit and
ignore policy.

Plan and brief work:

```bash
ops task plan TASK-0001
ops task brief TASK-0001 --worker codex
```

Attach results and verify manually:

```bash
ops task attach-result TASK-0001 path/to/result.md
ops task verify TASK-0001 --status passed --note "manual verification"
```

Generate task closure files:

```bash
ops task report TASK-0001
ops memory propose TASK-0001
```

Diagnose workspace state without changing files:

```bash
ops doctor
```

`ops doctor` is read-only. It checks required workspace files, SQLite health,
task directory/index consistency, task status consistency, expected generated
files for each status, and referenced artifact files. It exits with code `1`
when errors are found. Warnings, such as a completed task without
`memory_diff.md`, do not fail the command by themselves.

## Python Service Boundary

The CLI is intentionally thin. Future local adapters should call
`projectops.service` functions directly for workflow operations:

```python
from pathlib import Path

from projectops import service

root = Path.cwd()
service.init_workspace(root)
task = service.create_task(root, "Investigate a broken workflow")
plan = service.create_plan(root, task.id)
brief_path = service.create_worker_brief(root, task.id, worker="codex")
```

Normal workflow errors are raised as `ProjectOpsError` subclasses from
`projectops.errors`, so adapters can render their own user-facing messages.
The minimal internal adapter boundary is `projectops.adapters`, documented in
[docs/external_adapter_interface.md](docs/external_adapter_interface.md).
Its response shape is documented in
[docs/adapter_response_contract.md](docs/adapter_response_contract.md).
A local adapter demo is documented in
[docs/adapter_usage_examples.md](docs/adapter_usage_examples.md).
The deterministic text-command mapper is documented in
[docs/adapter_intent_mapping.md](docs/adapter_intent_mapping.md).
That document also covers the confirmation flow for mutating adapter intents.
The in-memory adapter session lifecycle is documented in
[docs/adapter_session_lifecycle.md](docs/adapter_session_lifecycle.md).
That lifecycle includes the reusable in-memory `AdapterSessionStore` for
channel adapters that need pending confirmation state.
The adapter event model for external UI rendering is documented in
[docs/adapter_event_model.md](docs/adapter_event_model.md).
The adapter text renderer policy is documented in
[docs/adapter_renderer_policy.md](docs/adapter_renderer_policy.md).
That policy includes local channel-specific rendering choices for OpenClaw,
Slack, Telegram, terminal, and log output.
The full local adapter pipeline contract is documented in
[docs/adapter_pipeline_contract.md](docs/adapter_pipeline_contract.md).
The local channel adapter contract and smoke flow are documented in
[docs/channel_adapter_contract.md](docs/channel_adapter_contract.md).
The advisory adapter permission policy is documented in
[docs/adapter_permission_policy.md](docs/adapter_permission_policy.md).
The future OpenClaw adapter design is documented in
[docs/openclaw_adapter_design.md](docs/openclaw_adapter_design.md).
Real OpenClaw runtime research and gap analysis are documented in
[docs/openclaw_runtime_research.md](docs/openclaw_runtime_research.md) and
[docs/openclaw_integration_gap_analysis.md](docs/openclaw_integration_gap_analysis.md).
The local stdio JSON bridge protocol for future external process integrations
is documented in [docs/stdio_bridge_protocol.md](docs/stdio_bridge_protocol.md).
The local stdio bridge client-wrapper contract is documented in
[docs/stdio_bridge_client_contract.md](docs/stdio_bridge_client_contract.md).
The stdio bridge process supervision policy for future wrappers is documented
in [docs/stdio_bridge_process_supervision.md](docs/stdio_bridge_process_supervision.md).
The stdio bridge diagnostics contract for future stderr events is documented
in [docs/stdio_bridge_diagnostics_contract.md](docs/stdio_bridge_diagnostics_contract.md).
The bridge can optionally emit structured `DiagnosticEvent` JSON lines through
a `DiagnosticWriter` while keeping stdout reserved for protocol responses.
The subprocess capture demo verifies stdout/stderr separation:
`python3 examples/stdio_bridge_diagnostics_capture_demo.py`.
The placeholder OpenClaw adapter skeleton lives under
`src/projectops/adapters/openclaw/`; it does not import or integrate real
OpenClaw. The skeleton also includes local OpenClaw-like payload normalization
for raw dictionaries, still without real OpenClaw imports or API calls.

Accepted verification statuses are:

- `passed`
- `failed`
- `blocked`

## Example End-To-End Usage

```bash
ops init
ops status

ops task create "Add a command that lists all tasks with id, status, title, created_at, and updated_at"
ops task show TASK-0001
ops task plan TASK-0001
ops task brief TASK-0001 --worker codex
```

Open the generated brief:

```bash
cat .projectops/tasks/TASK-0001/worker_brief_codex.md
```

Copy the brief into Codex manually. After Codex produces a result, save that
result as a local file and attach it:

```bash
ops task attach-result TASK-0001 path/to/codex_result.md
ops task verify TASK-0001 --status passed --note "pytest passed and manual check passed"
ops task report TASK-0001
ops memory propose TASK-0001
ops task list
```

## Workspace Structure

`ops init` creates a local `.projectops/` directory in the current project:

```text
.projectops/
  config.yaml
  state.sqlite
  memory/
    project.md
    preferences.yaml
    decisions/
  tasks/
    TASK-0001/
      task_spec.yaml
      plan.yaml
      worker_brief_codex.md
      artifacts/
      artifacts.yaml
      verification_record.yaml
      final_report.md
      memory_diff.md
```

Not every task file exists immediately. Files are created as the task moves
through the workflow.

## Task Lifecycle

Supported task statuses:

- `draft`
- `planned`
- `briefed`
- `result_attached`
- `verifying`
- `verified`
- `completed`
- `blocked`
- `failed`

Typical status transitions:

```text
draft
-> planned
-> briefed
-> result_attached
-> verified
-> completed
```

Failed or blocked verification moves the task to `failed` or `blocked`.

Command effects:

- `ops task create` creates `task_spec.yaml`, `artifacts/`, and a SQLite row.
- Task defaults include conservative success criteria and constraints against
  destructive operations, external APIs, and unrelated changes.
- `ops task plan` creates `plan.yaml` and sets status to `planned`.
- `ops task brief --worker codex` creates `worker_brief_codex.md` and sets
  status to `briefed`.
- `ops task attach-result` copies a file into `artifacts/`, updates
  `artifacts.yaml`, and sets status to `result_attached`.
- `ops task verify --status passed` creates `verification_record.yaml` and sets
  status to `verified`.
- `ops task verify --status failed` sets status to `failed`.
- `ops task verify --status blocked` sets status to `blocked`.
- `ops task report` creates `final_report.md`; if verification passed, it sets
  status to `completed`.
- `ops memory propose` creates `memory_diff.md` but does not update global
  project memory.
- `ops doctor` reports workspace errors and warnings without repairing or
  modifying files.

## Current Limitations

- Codex execution is manual. The CLI only generates a brief to copy into Codex.
- Verification is manual. The CLI records verification notes but does not run
  shell commands automatically.
- `memory_diff.md` is only a proposal and is not applied to
  `.projectops/memory/project.md`.
- JSON output is currently limited to `ops status`, `ops task list`, and
  `ops doctor`.
- `ops task list` has no filtering or pagination.
- `ops doctor` is diagnostic only. It does not repair missing files, normalize
  state, or apply memory updates.
- Tasks are indexed in SQLite; manually created task directories without SQLite
  rows will not appear in `ops task list`.
- There is no OpenClaw integration, web UI, vector memory, or multi-agent
  orchestration.

## Next Roadmap

- Add richer `ops status` output with recent tasks and statuses.
- Add safer validation around task state transitions.
- Add optional command-result capture for verification without making the tool
  autonomous.
- Add structured output to additional commands where adapters need it.
- Add memory review/apply commands that keep proposals explicit and auditable.
- Add more focused tests around failure paths and corrupted workspace files.

See `AGENTS.md` for repository rules and implementation constraints.
