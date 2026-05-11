# Adapter JSON Contracts

## Purpose

These schemas define stable machine-readable output contracts for future
Weaveflow adapters. Adapters such as OpenClaw, Slack, Telegram, desktop UI,
web UI, or automation scripts should consume structured outputs instead of
parsing human-readable CLI text.

The schemas use JSON Schema Draft 2020-12.

## Contract Version

All current JSON outputs include:

```json
{
  "contract_version": "weaveflow.v1"
}
```

Adapters should check `contract_version` before consuming a payload.
`weaveflow.v1` is the current adapter contract version and covers:

- `weaveflow status --json`
- `weaveflow task list --json`
- `weaveflow doctor --json`
- `AdapterResponse` from `weaveflow.adapters`

See [contract_changelog.md](contract_changelog.md) for version history and
compatibility rules.

## Supported JSON Commands

- `weaveflow status --json`
- `weaveflow task list --json`
- `weaveflow doctor --json`

## Non-Goals

- This does not integrate OpenClaw.
- This does not create a server.
- This does not add autonomous execution.
- This does not define every future API.
- This only documents current CLI JSON contracts.

## Schema Files

CLI JSON schemas:

- `schemas/status.schema.json`
- `schemas/task_list.schema.json`
- `schemas/doctor.schema.json`

Internal adapter response schema:

- `schemas/adapter_response.schema.json`

The CLI JSON schemas are separate from the internal `AdapterResponse` schema.
They share the same `contract_version` value but represent different integration
surfaces.

## Example Outputs

`weaveflow status --json`:

```json
{
  "contract_version": "weaveflow.v1",
  "workspace_exists": true,
  "workspace_path": "/repo/.weaveflow",
  "state_db_path": "/repo/.weaveflow/state.sqlite",
  "memory_path": "/repo/.weaveflow/memory",
  "task_count": 1,
  "tasks": [
    {
      "id": "TASK-0001",
      "title": "Example task",
      "status": "completed",
      "created_at": "2026-05-09T09:00:00+00:00",
      "updated_at": "2026-05-09T09:05:00+00:00"
    }
  ]
}
```

`weaveflow task list --json`:

```json
{
  "contract_version": "weaveflow.v1",
  "tasks": [
    {
      "id": "TASK-0001",
      "title": "Example task",
      "status": "completed",
      "created_at": "2026-05-09T09:00:00+00:00",
      "updated_at": "2026-05-09T09:05:00+00:00"
    }
  ],
  "count": 1
}
```

`weaveflow doctor --json`:

```json
{
  "contract_version": "weaveflow.v1",
  "healthy": true,
  "ok_count": 12,
  "warn_count": 0,
  "error_count": 0,
  "checks": [
    {
      "level": "ok",
      "name": "workspace_exists",
      "message": "workspace exists: .weaveflow",
      "path": ".weaveflow"
    }
  ]
}
```

## Adapter Usage Notes

- Adapters should consume `--json` output instead of parsing human-readable text.
- Adapters should check `contract_version` before consuming the payload.
- Default CLI output remains optimized for humans.
- `weaveflow doctor --json` exits with code `1` when errors are found, but it still
  prints a valid JSON report to stdout.
- `weaveflow status --json` works before `weaveflow init` and reports
  `"workspace_exists": false`.
- `weaveflow task list --json` requires the workspace to exist. If the workspace is
  missing, it exits non-zero with the existing clean user-facing error.

## Stability Policy

- Adding optional fields is allowed.
- Adding optional fields within `weaveflow.v1` is allowed.
- Removing required fields is a breaking change.
- Changing field types is a breaking change.
- Renaming fields is a breaking change.
- Changing the `contract_version` value indicates a new contract version.
- Changing human-readable output is not part of this JSON contract.
