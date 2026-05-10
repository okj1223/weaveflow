# Stdio Bridge Diagnostics Contract

## Purpose

This document defines the diagnostics contract for future stderr output from
the ProjectOps stdio bridge and external wrappers.

stdout remains the protocol channel. stderr is diagnostics-only. This is not
real OpenClaw integration. This is not a server logging system. This does not
implement runtime diagnostics yet.

In short: stdout is protocol-only, stderr is diagnostics-only.

## Non-Goals

- no OpenClaw integration
- no real OpenClaw plugin
- no server
- no network
- no webhook listener
- no network listener
- no production logging framework
- no persistent log store
- no authentication runtime
- no authorization runtime
- no external APIs
- no auto-running Codex
- no runtime stderr logging implementation in this phase

## stdout/stderr Boundary

stdout:

- must contain only JSON bridge responses
- one response per request line
- safe for protocol clients to parse
- no human diagnostics

stderr:

- may contain diagnostic events
- should not be used for protocol responses
- may be captured by future wrappers
- may be summarized for users after sanitization
- must not be required for normal request handling

## Proposed Diagnostic Event Shape

Future stderr diagnostics may use JSON lines shaped like:

```json
{
  "contract_version": "projectops.v1",
  "diagnostic_version": "projectops.diagnostics.v1",
  "level": "info",
  "event": "bridge_started",
  "bridge_request_id": null,
  "request_id": null,
  "action": null,
  "message": "ProjectOps stdio bridge started.",
  "timestamp": "2026-05-09T00:00:00Z",
  "metadata": {}
}
```

Required fields:

- `contract_version`
- `diagnostic_version`
- `level`
- `event`
- `bridge_request_id`
- `request_id`
- `action`
- `message`
- `timestamp`
- `metadata`

Allowed levels:

- `debug`
- `info`
- `warning`
- `error`

Suggested event names:

- `bridge_started`
- `bridge_stopped`
- `request_received`
- `request_completed`
- `request_failed`
- `protocol_error`
- `normalization_error`
- `timeout`
- `shutdown_requested`
- `session_lost`
- `doctor_error`
- `unexpected_error`

This shape is proposed for future implementation. Not all events are emitted
today. Future implementation should keep diagnostics JSON-safe.

## Correlation Policy

`bridge_request_id` correlates stdio bridge request and response values.
`request_id` correlates adapter/session-level user messages. `action` records
the adapter action if known.

Future wrappers should log both IDs when available. Missing IDs should be null,
not omitted.

## Sanitization Policy

Diagnostics must avoid:

- secrets
- API keys
- tokens
- raw credentials
- full stack traces to end users
- unnecessary absolute local paths
- full raw payloads by default
- user-private content unless necessary for debugging

Diagnostics may include:

- action
- event type
- error type
- safe message
- duration
- `bridge_request_id`
- `request_id`
- sanitized path placeholder
- compact metadata

## User-Facing Policy

stderr diagnostics are not automatically user-facing. Future wrappers may
display sanitized summaries, but raw stderr should not be pasted directly into
chat surfaces.

User-facing messages should come from `AdapterEvent` renderers or clean bridge
errors. Diagnostics are for operators and developers.

## Error And Exception Policy

Normal bad input should produce a stdout JSON error response. stderr may
additionally receive a diagnostic event later.

Unexpected exceptions may be logged to stderr in sanitized form. stdout must
still return valid JSON when possible. Wrappers should treat non-JSON stdout as
a protocol violation.

## Future Wrapper Behavior

Future external wrappers should:

- capture stderr separately from stdout
- never parse stderr as protocol
- optionally persist sanitized diagnostics
- correlate stderr events with stdout responses using `bridge_request_id`
- avoid showing raw diagnostics to end users
- surface clean summaries when useful
- treat repeated error diagnostics as a bridge health signal

## Relationship To Process Supervision

[stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md)
defines lifecycle, restart, and timeout policy. This diagnostics contract
defines what may appear on stderr.

Timeout, restart, and session-loss events may be represented as diagnostic
events in the future. This phase does not implement those emissions.

## Example Diagnostic Events

bridge_started:

```json
{"contract_version":"projectops.v1","diagnostic_version":"projectops.diagnostics.v1","level":"info","event":"bridge_started","bridge_request_id":null,"request_id":null,"action":null,"message":"ProjectOps stdio bridge started.","timestamp":"2026-05-09T00:00:00Z","metadata":{}}
```

request_completed:

```json
{"contract_version":"projectops.v1","diagnostic_version":"projectops.diagnostics.v1","level":"info","event":"request_completed","bridge_request_id":"bridge-001","request_id":"m1","action":"status","message":"Bridge request completed.","timestamp":"2026-05-09T00:00:01Z","metadata":{"duration_ms":12}}
```

normalization_error:

```json
{"contract_version":"projectops.v1","diagnostic_version":"projectops.diagnostics.v1","level":"warning","event":"normalization_error","bridge_request_id":"bridge-002","request_id":null,"action":null,"message":"Payload normalization failed.","timestamp":"2026-05-09T00:00:02Z","metadata":{"error_type":"OpenClawPayloadNormalizationError"}}
```

session_lost:

```json
{"contract_version":"projectops.v1","diagnostic_version":"projectops.diagnostics.v1","level":"warning","event":"session_lost","bridge_request_id":null,"request_id":null,"action":null,"message":"Pending confirmations were cleared after bridge restart.","timestamp":"2026-05-09T00:00:03Z","metadata":{}}
```

shutdown_requested:

```json
{"contract_version":"projectops.v1","diagnostic_version":"projectops.diagnostics.v1","level":"info","event":"shutdown_requested","bridge_request_id":"bridge-999","request_id":null,"action":null,"message":"Bridge shutdown requested.","timestamp":"2026-05-09T00:00:04Z","metadata":{}}
```

## Future Implementation Checklist

- add diagnostic event model
- add stderr writer
- ensure stdout remains JSON-only
- add tests for stderr JSON lines
- add sanitization helper
- add wrapper capture tests
- add process supervision integration
- add diagnostic version changelog
