# AdapterResponse Contract

## Purpose

This document defines the stable JSON shape returned by the internal ProjectOps
adapter boundary. Future adapters such as OpenClaw, Slack, Telegram, desktop UI,
web UI, or automation scripts can consume `AdapterResponse` objects without
inventing their own response format.

This is not OpenClaw integration. It does not create a server, bot, network
listener, autonomous worker, or external API integration. It only defines the
internal adapter response contract.

## Current Contract Version

All adapter responses use:

```text
projectops.v1
```

Adapters should reject unknown contract versions unless explicitly configured
to support them.

## Schema File

The JSON Schema for this response is:

```text
schemas/adapter_response.schema.json
```

The schema uses JSON Schema Draft 2020-12.

## Field Definitions

Required top-level fields:

- `contract_version`: string, currently `projectops.v1`.
- `ok`: boolean indicating whether the adapter action succeeded.
- `action`: string action name from the original request.
- `message`: non-empty human-readable summary.
- `data`: object or null containing JSON-safe result data.
- `error_type`: string or null error category.
- `error_message`: string or null clean error message.
- `read_only`: boolean indicating whether the requested action is read-only.
- `request_id`: string or null request correlation value from the request.

## Success Semantics

When `ok` is `true`:

- `error_type` is null.
- `error_message` is null.
- `message` is non-empty.
- `data` may be an object or null depending on the action.

## Error Semantics

When `ok` is `false`:

- `error_type` is a non-empty string.
- `error_message` is a non-empty string.
- `message` is non-empty.
- `data` is null unless a future action has a deliberate documented reason to
  include structured error data.

Normal ProjectOps workflow errors are returned as clean adapter responses. Raw
Python stack traces should not be exposed to external users.

## read_only Semantics

Read-only actions return `read_only: true`:

- `status`
- `list_tasks`
- `doctor`
- `show_task`

Mutating actions return `read_only: false`:

- `init_workspace`
- `create_task`
- `create_plan`
- `create_worker_brief`
- `attach_result`
- `verify_task`
- `create_final_report`
- `propose_memory_update`

Mutation-not-allowed errors for mutating actions also return
`read_only: false`, because the requested action is mutating even though the
adapter blocked it before any state change.

## Mutation Gating

Mutating actions require `allow_mutation=True` on `AdapterRequest`. If a
mutating action is requested without that flag, the adapter returns:

- `ok: false`
- `error_type: MutationNotAllowed`
- `data: null`
- `read_only: false`

The service function is not called, and workspace state is not changed.

## request_id Semantics

If `AdapterRequest.request_id` is provided, the adapter copies it to
`AdapterResponse.request_id`. This lets future external adapters correlate
responses with incoming messages or commands.

## JSON Serializability

`AdapterResponse` payloads must be JSON-serializable. Response data must not
contain raw Pydantic models, `pathlib.Path` objects, enums, or other values that
cannot be serialized as JSON.

## Success Example

```json
{
  "contract_version": "projectops.v1",
  "ok": true,
  "action": "status",
  "message": "Adapter action succeeded: status",
  "data": {
    "workspace_exists": false,
    "task_count": 0,
    "tasks": []
  },
  "error_type": null,
  "error_message": null,
  "read_only": true,
  "request_id": "req-123"
}
```

## Error Example

```json
{
  "contract_version": "projectops.v1",
  "ok": false,
  "action": "init_workspace",
  "message": "Mutation not allowed for adapter action: init_workspace. Set allow_mutation=True to run this action.",
  "data": null,
  "error_type": "MutationNotAllowed",
  "error_message": "Mutation not allowed for adapter action: init_workspace. Set allow_mutation=True to run this action.",
  "read_only": false,
  "request_id": null
}
```

## Future OpenClaw Usage Notes

A future OpenClaw adapter should call `ProjectOpsServiceAdapter` or
`projectops.service` and render `AdapterResponse` to the OpenClaw user. It
should not mutate `.projectops/` files, SQLite, task statuses, or artifacts
directly.

## Non-Goals

- This does not integrate OpenClaw.
- This does not create a server.
- This does not call external APIs.
- This does not define every future adapter API.
- This does not change existing CLI JSON output.
