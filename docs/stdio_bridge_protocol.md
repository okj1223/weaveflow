# Stdio Bridge Protocol

## Purpose

The stdio bridge is a local stdin/stdout JSON bridge for future external
process integrations. A future OpenClaw plugin, local automation script, or
other process can spawn the Python bridge, send line-delimited JSON requests,
and receive line-delimited JSON responses.

This keeps ProjectOps local-first while giving non-Python callers a narrow
process boundary.

For the external process-wrapper side of this protocol, see
[stdio_bridge_client_contract.md](stdio_bridge_client_contract.md). This
protocol defines request and response lines; the client contract defines how a
future wrapper should spawn the process, keep it alive, correlate
`bridge_request_id`, and shut it down.
For wrapper lifecycle, timeout, restart, stdout, and stderr policy, see
[stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md).
For lightweight ping health check helpers and JSON line validation, see
[stdio_bridge_health_checks.md](stdio_bridge_health_checks.md).
For the future structured stderr diagnostics shape, see
[stdio_bridge_diagnostics_contract.md](stdio_bridge_diagnostics_contract.md).

## Non-Goals

- This is not real OpenClaw integration.
- This is not a server.
- This provides no server.
- This provides no network listener.
- This provides no authentication.
- This is not a network protocol.
- This is not authenticated.
- This is not persistent.
- This is not an external API.
- This is not autonomous execution.
- This is not a bot.

## Protocol Shape

- Transport: line-delimited JSON over stdin and stdout.
- One request per input line.
- One response per output line.
- A bridge process owns one in-memory `OpenClawAdapter` instance.
- stdout must contain only JSON response lines.
- stderr may be used later for diagnostics, but this phase keeps diagnostics
  minimal and does not require stderr output.
- A future process wrapper should treat stdout as protocol-only and stderr as
  diagnostics-only.
- Future stderr diagnostics are not protocol responses and should be captured
  separately from stdout.
- PHASE 10-M adds optional `DiagnosticWriter` support so diagnostics can be
  emitted to stderr or an injected diagnostics stream while stdout remains
  JSON-only protocol output.

## Request Schema

`StdioBridgeRequest` fields:

- `contract_version`: must be `projectops.v1`
- `bridge_request_id`: caller-provided request identifier
- `type`: bridge request type
- `payload`: object payload, empty for request types that do not need one

Example:

```json
{"contract_version":"projectops.v1","bridge_request_id":"bridge-001","type":"ping","payload":{}}
```

## Response Schema

`StdioBridgeResponse` fields:

- `contract_version`: always `projectops.v1`
- `bridge_request_id`: copied from the request when available
- `ok`: bridge-level success flag
- `type`: request type, or `invalid` for malformed input
- `response`: response object or null
- `error_type`: bridge error type or null
- `error_message`: bridge error message or null

## Supported Request Types

### ping

Health check for the bridge process. It does not touch ProjectOps workspace
state.
`ping` is the basic protocol health check; wrapper-level helpers validate the
stdout `StdioBridgeResponse` shape and require `pong=true`.

Response:

```json
{"contract_version":"projectops.v1","bridge_request_id":"bridge-001","ok":true,"type":"ping","response":{"pong":true},"error_type":null,"error_message":null}
```

### handle_payload

Routes an OpenClaw-like raw payload through:

```text
OpenClawAdapter.handle_payload
-> AdapterSession
-> ProjectOpsServiceAdapter
-> AdapterEvent
-> rendered OpenClawResponse payload
```

The `payload` object is the same raw OpenClaw-like dictionary accepted by the
local `OpenClawAdapter.handle_payload` skeleton.

### shutdown

The bridge supports `shutdown`. It returns a JSON acknowledgement and the bridge
loop exits cleanly when `stop_on_shutdown` is true.

## Example Requests And Responses

Ping:

```json
{"contract_version":"projectops.v1","bridge_request_id":"b-1","type":"ping","payload":{}}
```

Status through `handle_payload`:

```json
{"contract_version":"projectops.v1","bridge_request_id":"b-2","type":"handle_payload","payload":{"channelId":"channel-1","userId":"user-1","messageId":"m1","content":"status","createdAt":"2026-05-09T00:00:00Z","threadId":"thread-1"}}
```

Init workspace pending confirmation:

```json
{"contract_version":"projectops.v1","bridge_request_id":"b-3","type":"handle_payload","payload":{"channelId":"channel-1","userId":"user-1","messageId":"m2","content":"init workspace","createdAt":"2026-05-09T00:00:00Z","threadId":"thread-1"}}
```

Confirm with yes:

```json
{"contract_version":"projectops.v1","bridge_request_id":"b-4","type":"handle_payload","payload":{"channelId":"channel-1","userId":"user-1","messageId":"m3","content":"yes","createdAt":"2026-05-09T00:00:00Z","threadId":"thread-1"}}
```

Invalid JSON response shape:

```json
{"contract_version":"projectops.v1","bridge_request_id":"","ok":false,"type":"invalid","response":null,"error_type":"InvalidBridgeJson","error_message":"Invalid JSON request."}
```

## Session Behavior

A running bridge process owns one `OpenClawAdapter` instance. That means the
adapter's in-memory sessions and pending confirmations persist across request
lines for the life of that process.

This supports flows like:

```text
init workspace -> pending confirmation
yes -> confirmed mutation
create task -> pending confirmation
yes -> confirmed mutation
```

There is no cross-process recovery. Starting a new bridge process creates a new
in-memory session store. `.projectops` files and SQLite remain the source of
truth for ProjectOps task state.

Rendered bridge responses are not the source of truth.

## Safety

- Do not expose the stdio bridge directly to a network.
- Do not use the bridge as an authentication boundary.
- A future OpenClaw plugin should own process spawning and access control.
- ProjectOps confirmation flow still gates mutations.
- The bridge does not bypass `AdapterSession` or `ProjectOpsServiceAdapter`.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw plugin
-> spawn ProjectOps stdio bridge
-> send handle_payload request
-> receive JSON response
-> render or pass response to OpenClaw user
```

This is a ProjectOps-side local process bridge. It is not an OpenClaw-confirmed
runtime API.
