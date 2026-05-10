# Stdio Bridge Health Checks

## Purpose

This document defines lightweight bridge health checks for future external
process wrappers around the ProjectOps stdio bridge.

The helpers are local Python preflight checks. They are meant for future
wrappers, such as a future OpenClaw Node or Gateway wrapper, before normal
message handling starts.

## Non-Goals

- not real OpenClaw integration
- not a process supervisor
- no server
- not a network protocol
- no authentication
- not persistent sessions
- not production monitoring
- not Codex automation

## What Health Means

The health check confirms:

- the bridge process can respond to `ping`
- stdout response JSON has the `StdioBridgeResponse` shape
- the ping response contains `pong=true`
- optional stderr diagnostics have the `DiagnosticEvent` shape
- stdout and stderr are not mixed

The health check does not confirm:

- workspace `doctor` health
- authorization or user permission
- persistent sessions
- long-running task execution
- Codex automation

## Validation Helpers

`BridgeLineValidationResult` records validation for one line. It includes
`ok`, `line_type`, `parsed`, `error_type`, and `error_message`.

`BridgeHealthResult` records a full preflight result. It includes `ok`,
`bridge_request_id`, `pong`, `stdout_valid`, `stderr_valid`, clean error
fields, a human-readable `summary`, the ping `response`, and collected
diagnostics.

`validate_stdout_response_line` parses one stdout line and checks that it looks
like a `StdioBridgeResponse`.

`validate_stderr_diagnostic_line` parses one stderr line and checks that it
looks like a `DiagnosticEvent`.

`check_bridge_subprocess_health` starts a short-lived bridge subprocess, sends
`ping` and `shutdown`, validates stdout and optional stderr diagnostics, and
returns `BridgeHealthResult`.

## Recommended Wrapper Behavior

A future wrapper should:

- start the bridge
- send `ping`
- validate the response
- optionally validate stderr diagnostics
- run `doctor` separately for workspace health
- show a clean summary if the health check fails
- avoid sending mutating requests until bridge health passes

## Relationship To Process Supervision

[stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md)
defines lifecycle and restart policy. This health helper is a smaller
preflight check.

A failing health check should block wrapper use until resolved. The helper does
not silently restart the bridge, does not retry mutating actions, and does not
keep a bridge process alive.

## Failure Summaries

Example summaries:

- `Bridge health check failed: Bridge stdout response was not valid JSON.`
- `Bridge health check failed: ping response did not contain pong=true.`
- `Bridge process exited with code 1.`
- `Bridge health check failed: Bridge stdout response missing fields: bridge_request_id.`
- `Bridge health check failed: Bridge stderr diagnostic line was not valid JSON.`

These summaries are intended for future wrappers and operator logs, not as a
replacement for `AdapterEvent` rendering.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw wrapper startup
-> spawn bridge
-> run bridge health check
-> if ok, handle messages
-> if not ok, report clean error and do not process mutating actions
```

OpenClaw should still treat ProjectOps as the source of truth for task state.
The health helper checks bridge responsiveness only.

## Example

```python
from pathlib import Path
from projectops.adapters.stdio_health import check_bridge_subprocess_health

result = check_bridge_subprocess_health(Path("/path/to/workspace"), diagnostics=True)
if not result.ok:
    print(result.summary)
else:
    print("bridge is healthy")
```
