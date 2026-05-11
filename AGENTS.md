# AGENTS.md

Rules for agents working in this repository.

## Repository Goal

Build a local-first Weaveflow MVP.

This project is a small workflow system that converts a user request into a
human-readable, file-based task record:

1. `task_spec.yaml`
2. `plan.yaml`
3. `worker_brief_codex.md`
4. `artifacts/`
5. `artifacts.yaml`
6. `verification_record.yaml`
7. `final_report.md`
8. `memory_diff.md`

The first MVP must be a Python CLI named `weaveflow`.

## Non-Goals

Do not implement these yet:

- OpenClaw integration
- OpenAI API calls
- Autonomous agents
- Vector memory
- Web UI
- Multi-agent orchestration
- Chatbot behavior
- Thin Codex wrapper behavior

## Required Technology

- Python 3.11+
- Typer for CLI
- Pydantic for schemas
- PyYAML for YAML serialization
- SQLite for a basic state index
- `pathlib` for filesystem paths
- pytest for tests

## Required Workspace Structure

The MVP manages a local `.weaveflow/` workspace:

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

## Required MVP CLI

The CLI command name is `weaveflow`.

Required commands:

```text
weaveflow init
weaveflow task create "USER REQUEST"
weaveflow task show TASK-0001
weaveflow task plan TASK-0001
weaveflow task brief TASK-0001 --worker codex
weaveflow task attach-result TASK-0001 path/to/result.md
weaveflow task verify TASK-0001 --status passed --note "manual verification"
weaveflow task report TASK-0001
weaveflow memory propose TASK-0001
weaveflow status
```

## Task Statuses

Use only these task statuses unless a future task explicitly changes the
contract:

- `draft`
- `planned`
- `briefed`
- `result_attached`
- `verifying`
- `verified`
- `completed`
- `blocked`
- `failed`

## Implementation Rules

- Keep the implementation small, testable, and file-based.
- Keep code readable.
- Use small modules.
- Use type hints.
- Do not hardcode absolute paths.
- Use structured schemas for generated YAML files.
- Every generated file must be human-readable.
- Every command must fail with a helpful error message if the workspace or task
  does not exist.
- Generate files that can be manually copied into Codex.
- Default task constraints must include:
  - `Do not perform destructive operations without explicit approval`
  - `Do not call external APIs in this MVP`
  - `Do not make unrelated changes`
- Write tests for core functionality.
- After every implementation task, run tests if possible.

## File Boundaries

- Do not implement application code until explicitly asked.
- Do not create package scaffolding, tests, CLI modules, or configuration files
  unless the current task asks for them.
- Prefer minimal, focused changes that directly serve the current request.

## Reporting Rule

At the end of each task, report:

- What changed
- Files created or modified
- Commands run
- Test result
- Known limitations
- Next recommended prompt
