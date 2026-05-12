# Weaveflow

Weaveflow is a local-first workflow system MVP.

It provides a Python CLI named `weaveflow` that turns a user request into a
structured task workspace. Each task is represented by human-readable files
such as a task spec, plan, Codex worker brief, artifacts, verification record,
final report, and proposed memory update.

## What This Project Is

- A small, file-based workflow kernel for project operations.
- A local CLI for creating, planning, briefing, verifying, and reporting tasks.
- A way to generate `worker_brief_codex.md` files that can be manually copied
  into Codex.
- A SQLite-backed index for task IDs, titles, statuses, timestamps, and task
  directories.
- A Python service boundary in `weaveflow.service` that external interfaces
  can call without going through Typer.
- A separate OpenClaw stdio POC under
  `integrations/openclaw-weaveflow-stdio-poc/` for exercising the local bridge
  and Codex job-runner workflow without changing the core MVP boundary.
- A testable Python package built with Typer, Pydantic, PyYAML, SQLite, and
  pytest.

## What This Project Is Not

- It is not a chatbot.
- It is not a thin Codex wrapper.
- The core CLI does not control Codex automatically.
- It does not call the OpenAI API.
- It does not provide a production OpenClaw integration.
- It does not expose network, bot, desktop, or web adapters yet.
- The core MVP does not run autonomous agents.
- It does not implement vector memory.
- It does not provide a web UI.
- The core MVP does not orchestrate multiple workers.

The MVP intentionally keeps Codex interaction manual: `weaveflow task brief` generates
a `worker_brief_codex.md` file, and a developer copies that brief into Codex.
The result from Codex is then attached back to the task as an artifact.

## MVP Workflow

```text
User request
-> weaveflow task create
-> weaveflow task plan
-> weaveflow task brief
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

Use Python 3.11 or newer. From the repository root:

```bash
python3.11 -m pip install -e ".[dev]"
```

Confirm the CLI entry point and Python test suite with:

```bash
weaveflow --help
PYTHONPATH=src python3 -m pytest
```

If your local machine uses `python` or `python3` for Python 3.11+, those commands
are fine too.

The OpenClaw stdio POC uses plain Node ESM and the built-in Node test runner.
It has no package dependencies to install:

```bash
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
```

## CLI Commands

`weaveflow` is the primary command. The old `ops` entry point remains installed
as a compatibility alias during the rename transition.

Initialize and inspect the workspace:

```bash
weaveflow init
weaveflow status
weaveflow status --json
weaveflow doctor
weaveflow doctor --json
```

Create and inspect tasks:

```bash
weaveflow task create "USER REQUEST"
weaveflow task show TASK-0001
weaveflow task list
weaveflow task list --json
```

`weaveflow task list` reads from SQLite and prints one row per task with id, status,
title, `created_at`, and `updated_at`:

```text
TASK-0001 | completed | Example title | 2026-05-09T... | 2026-05-09T...
```

`weaveflow status --json`, `weaveflow task list --json`, and `weaveflow doctor --json` provide
machine-readable output for scripts and future adapters. The default output is
still human-readable.

The JSON contracts are documented in [docs/adapter_contracts.md](docs/adapter_contracts.md)
and validated by schemas in [schemas/](schemas/). Current JSON outputs use
`contract_version: "weaveflow.v1"`.
Future adapter expectations are documented in
[docs/external_adapter_interface.md](docs/external_adapter_interface.md).

Plan and brief work:

```bash
weaveflow task plan TASK-0001
weaveflow task brief TASK-0001 --worker codex
```

Attach results and verify manually:

```bash
weaveflow task attach-result TASK-0001 path/to/result.md
weaveflow task verify TASK-0001 --status passed --note "manual verification"
```

Generate task closure files:

```bash
weaveflow task report TASK-0001
weaveflow memory propose TASK-0001
```

Diagnose workspace state without changing files:

```bash
weaveflow doctor
```

`weaveflow doctor` is read-only. It checks required workspace files, SQLite health,
task directory/index consistency, task status consistency, expected generated
files for each status, and referenced artifact files. It exits with code `1`
when errors are found. Warnings, such as a completed task without
`memory_diff.md`, do not fail the command by themselves.

## OpenClaw/Codex POC Operator Workflow

The repository includes a local OpenClaw stdio POC at
`integrations/openclaw-weaveflow-stdio-poc/`. Treat it as a development harness:
Weaveflow remains the local task system, `.weaveflow/` remains the source of
truth, and OpenClaw is only the future channel surface for invoking local tools.

For a first-read local validation pass, run:

```bash
weaveflow init
weaveflow doctor
PYTHONPATH=src python3 -m pytest
npm test --prefix integrations/openclaw-weaveflow-stdio-poc
```

When using the Codex job-runner tools from the OpenClaw POC:

1. Start with `weaveflow_start_codex_job`, passing at least `repoRoot` and
   `userRequest`. Add `timeBudgetMinutes`, `sessionMode: "multi_step"`, and
   `maxSteps` when the request should be split into bounded steps.
2. Monitor with `weaveflow_check_codex_job jobId=JOB-0001`. The status output
   points to job artifacts, recent logs, the selected scope, checks, branch,
   and session-step progress.
3. Stop an in-flight job with `weaveflow_cancel_codex_job jobId=JOB-0001` when
   the operator needs to preserve logs and the temporary worktree for review.
4. Review `.weaveflow/jobs/JOB-0001/` for `job.yaml`, `events.jsonl`,
   `result.md`, and, in multi-step mode, `session_plan.md`,
   `session_summary.md`, and `steps/`.

The POC README has plugin-specific smoke and OpenClaw inspection commands:
[integrations/openclaw-weaveflow-stdio-poc/README.md](integrations/openclaw-weaveflow-stdio-poc/README.md).

## Repository Hygiene

Weaveflow is local-first, so `.weaveflow/` contains runtime workspace state.
Source code, tests, docs, schemas, and reviewed examples should be version
controlled. Local task history, SQLite state, and workspace memory are ignored
by default unless deliberately preserved elsewhere.

See [docs/repository_hygiene.md](docs/repository_hygiene.md) for the commit and
ignore policy.

## Python Service Boundary

The CLI is intentionally thin. Future local adapters should call
`weaveflow.service` functions directly for workflow operations:

```python
from pathlib import Path

from weaveflow import service

root = Path.cwd()
service.init_workspace(root)
task = service.create_task(root, "Investigate a broken workflow")
plan = service.create_plan(root, task.id)
brief_path = service.create_worker_brief(root, task.id, worker="codex")
```

Normal workflow errors are raised as `WeaveflowError` subclasses from
`weaveflow.errors`, so adapters can render their own user-facing messages.
The minimal internal adapter boundary is `weaveflow.adapters`, documented in
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
The wrapper-facing permission preflight helper is documented in
[docs/adapter_permission_preflight.md](docs/adapter_permission_preflight.md).
The explicit confirmation UX contract for sensitive adapter actions is
documented in
[docs/adapter_explicit_confirmation.md](docs/adapter_explicit_confirmation.md).
In-memory single-use replay protection for explicit confirmations is
documented in
[docs/confirmation_replay_protection.md](docs/confirmation_replay_protection.md).
Wrapper-facing stale confirmation notifications are documented in
[docs/stale_confirmation_notifications.md](docs/stale_confirmation_notifications.md).
Wrapper result rendering for future channel messages is documented in
[docs/wrapper_result_rendering.md](docs/wrapper_result_rendering.md).
Local wrapper transcript review artifacts are documented in
[docs/wrapper_transcript_review.md](docs/wrapper_transcript_review.md).
The integration readiness freeze and stop criteria before real OpenClaw work
are documented in
[docs/integration_readiness_freeze.md](docs/integration_readiness_freeze.md).
The local wrapper smoke flow that combines health checks, preflight, and stdio
routing decisions is documented in
[docs/local_wrapper_flow.md](docs/local_wrapper_flow.md).
Wrapper restart and session-loss behavior is documented in
[docs/local_wrapper_restart_session_loss.md](docs/local_wrapper_restart_session_loss.md).
Restart-aware wrapper notification payloads are documented in
[docs/wrapper_notification_contract.md](docs/wrapper_notification_contract.md).
The local wrapper explicit confirmation smoke demo is available at
`python3 examples/local_wrapper_explicit_confirmation_demo.py`.
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
The lightweight stdio bridge health-check helpers are documented in
[docs/stdio_bridge_health_checks.md](docs/stdio_bridge_health_checks.md).
The stdio bridge diagnostics contract for future stderr events is documented
in [docs/stdio_bridge_diagnostics_contract.md](docs/stdio_bridge_diagnostics_contract.md).
The bridge can optionally emit structured `DiagnosticEvent` JSON lines through
a `DiagnosticWriter` while keeping stdout reserved for protocol responses.
The subprocess capture demo verifies stdout/stderr separation:
`python3 examples/stdio_bridge_diagnostics_capture_demo.py`.
The placeholder OpenClaw adapter skeleton lives under
`src/weaveflow/adapters/openclaw/`; it does not import or integrate real
OpenClaw. The skeleton also includes local OpenClaw-like payload normalization
for raw dictionaries, still without real OpenClaw imports or API calls.

Accepted verification statuses are:

- `passed`
- `failed`
- `blocked`

## Example End-To-End Usage

```bash
weaveflow init
weaveflow status

weaveflow task create "Add a command that lists all tasks with id, status, title, created_at, and updated_at"
weaveflow task show TASK-0001
weaveflow task plan TASK-0001
weaveflow task brief TASK-0001 --worker codex
```

Open the generated brief:

```bash
cat .weaveflow/tasks/TASK-0001/worker_brief_codex.md
```

Copy the brief into Codex manually. After Codex produces a result, save that
result as a local file and attach it:

```bash
weaveflow task attach-result TASK-0001 path/to/codex_result.md
weaveflow task verify TASK-0001 --status passed --note "pytest passed and manual check passed"
weaveflow task report TASK-0001
weaveflow memory propose TASK-0001
weaveflow task list
```

## Workspace Structure

`weaveflow init` creates a local `.weaveflow/` directory in the current project:

```text
.weaveflow/
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

- `weaveflow task create` creates `task_spec.yaml`, `artifacts/`, and a SQLite row.
- Task defaults include conservative success criteria and constraints against
  destructive operations, external APIs, and unrelated changes.
- `weaveflow task plan` creates `plan.yaml` and sets status to `planned`.
- `weaveflow task brief --worker codex` creates `worker_brief_codex.md` and sets
  status to `briefed`.
- `weaveflow task attach-result` copies a file into `artifacts/`, updates
  `artifacts.yaml`, and sets status to `result_attached`.
- `weaveflow task verify --status passed` creates `verification_record.yaml` and sets
  status to `verified`.
- `weaveflow task verify --status failed` sets status to `failed`.
- `weaveflow task verify --status blocked` sets status to `blocked`.
- `weaveflow task report` creates `final_report.md`; if verification passed, it sets
  status to `completed`.
- `weaveflow memory propose` creates `memory_diff.md` but does not update global
  project memory.
- `weaveflow doctor` reports workspace errors and warnings without repairing or
  modifying files.

## Current Limitations

- Codex execution is manual. The CLI only generates a brief to copy into Codex.
- Verification is manual. The CLI records verification notes but does not run
  shell commands automatically.
- `memory_diff.md` is only a proposal and is not applied to
  `.weaveflow/memory/project.md`.
- JSON output is currently limited to `weaveflow status`, `weaveflow task list`, and
  `weaveflow doctor`.
- `weaveflow task list` has no filtering or pagination.
- `weaveflow doctor` is diagnostic only. It does not repair missing files, normalize
  state, or apply memory updates.
- Tasks are indexed in SQLite; manually created task directories without SQLite
  rows will not appear in `weaveflow task list`.
- There is no OpenClaw integration, web UI, vector memory, or multi-agent
  orchestration.

## Next Roadmap

- Add richer `weaveflow status` output with recent tasks and statuses.
- Add safer validation around task state transitions.
- Add optional command-result capture for verification without making the tool
  autonomous.
- Add structured output to additional commands where adapters need it.
- Add memory review/apply commands that keep proposals explicit and auditable.
- Add more focused tests around failure paths and corrupted workspace files.

See `AGENTS.md` for repository rules and implementation constraints.
