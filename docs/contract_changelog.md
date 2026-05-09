# Contract Changelog

## Purpose

This document records adapter-facing JSON contract versions for ProjectOps
Kernel. It helps external adapters decide which payload shapes they can consume
safely.

## Current Version

Current adapter contract version:

```text
projectops.v1
```

This version covers:

- `ops status --json`
- `ops task list --json`
- `ops doctor --json`

## projectops.v1 Required Fields

`ops status --json` requires these top-level fields:

- `contract_version`
- `workspace_exists`
- `workspace_path`
- `state_db_path`
- `memory_path`
- `task_count`
- `tasks`

`ops task list --json` requires these top-level fields:

- `contract_version`
- `tasks`
- `count`

`ops doctor --json` requires these top-level fields:

- `contract_version`
- `healthy`
- `ok_count`
- `warn_count`
- `error_count`
- `checks`

## Backward-Compatible Changes Within projectops.v1

These changes are backward-compatible within `projectops.v1`:

- Adding optional fields.
- Adding optional nested fields.
- Adding new commands with separate schemas.
- Expanding documentation.
- Adding warnings or check types when the schema still validates.

## Breaking Changes Requiring a New Version

These changes require a new contract version:

- Removing required fields.
- Renaming fields.
- Changing field types.
- Changing the `contract_version` value.
- Changing task status enum names.
- Changing doctor level enum names.
- Changing exit-code semantics for JSON commands.
- Making read-only JSON commands mutate state.

## Future projectops.v2 Policy

`projectops.v2` should be introduced with new schema files or updated schemas
that are clearly marked. Version 1 should remain supported during transition if
possible. Adapters should reject unknown contract versions unless explicitly
configured to accept them. Migration notes should be documented before release.

## Changelog Entries

### projectops.v1 - 2026-05-09

- Initial adapter-facing JSON contract.
- Added status, task list, and doctor schemas.
- Added `contract_version: projectops.v1`.
