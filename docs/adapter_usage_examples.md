# Adapter Usage Examples

## Purpose

This document demonstrates how to use the internal ProjectOps adapter boundary
locally. It shows how an external-style command can become an `AdapterRequest`,
flow through `ProjectOpsServiceAdapter`, and return an `AdapterResponse`.

## Non-Goals

- This is not OpenClaw integration.
- This is not a server.
- This does not call external APIs.
- This does not auto-run Codex.
- This does not create autonomous execution.

## What The Demo Shows

The local demo shows:

- Read-only adapter calls.
- Mutation-gated adapter calls.
- Error responses.
- Temporary workspace usage with `TemporaryDirectory`.
- JSON-safe `AdapterResponse` objects.

## How To Run

```bash
python3 examples/adapter_usage_demo.py
```

The script uses a temporary workspace and does not write into the repository's
real `.projectops/` directory.

## Future OpenClaw Usage Shape

A future OpenClaw adapter should:

- Receive a user message.
- Map it to an `AdapterRequest`.
- Decide whether mutation is allowed.
- Call `ProjectOpsServiceAdapter.handle`.
- Render `AdapterResponse` back to the user.
- Never mutate `.projectops/` files directly.
- Never parse human-readable CLI output.

## Example Mapping

| User intent | AdapterRequest action | Mutation allowed |
| --- | --- | --- |
| Show status | `status` | false |
| Create task | `create_task` | true |
| Generate Codex brief | `create_worker_brief` | true |
| Check workspace health | `doctor` | false |

## Safety Notes

- Mutating actions require `allow_mutation=True`.
- `MutationNotAllowed` responses are expected safety behavior.
- `request_id` can be used by future adapters for tracing.
- `AdapterResponse` is JSON-safe and versioned with
  `contract_version: projectops.v1`.
- External adapters should check `contract_version`.
