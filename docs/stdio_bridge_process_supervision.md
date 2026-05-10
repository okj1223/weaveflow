# Stdio Bridge Process Supervision

## Purpose

This document defines the recommended process supervision policy for future
wrappers around the ProjectOps stdio bridge.

This is not real OpenClaw integration. This is not a server API. This is not a
network protocol. This does not implement a production process supervisor. This
is a policy and contract document for future external wrappers.

For the future structured stderr diagnostic event shape, see
[stdio_bridge_diagnostics_contract.md](stdio_bridge_diagnostics_contract.md).

## Non-Goals

- no real OpenClaw plugin
- no bot runtime
- no server
- no network
- no webhook listener
- no network listener
- no persistent session store
- no authentication
- no authentication runtime
- no authorization runtime
- no external APIs
- no auto-running Codex
- no production-grade process manager

## Process Ownership

A future external process wrapper owns the bridge process. The wrapper writes
requests to stdin and reads responses from stdout. The ProjectOps stdio bridge
owns one in-memory `OpenClawAdapter` instance per running process.

Keeping the process alive preserves in-memory pending confirmations. Killing or
restarting the process loses pending confirmations. `.projectops` files and
SQLite remain the source of truth for durable task state. `AdapterSession` and
pending confirmations are interaction state only.

## Recommended Process Lifecycle

### A. Start

The wrapper starts the bridge process with:

```bash
python3 -m projectops.adapters.stdio_bridge --root <workspace-root>
```

The wrapper verifies bridge health using `ping`. It should not treat process
start alone as healthy until `ping` succeeds.

When structured diagnostics are useful, the wrapper may opt in with:

```bash
python3 -m projectops.adapters.stdio_bridge --root <workspace-root> --diagnostics-stderr
```

Wrappers should parse stdout as the protocol stream and capture stderr
separately as diagnostics.

### B. Normal Request

The wrapper sends one JSON line, waits for one JSON line response, correlates
the response by `bridge_request_id`, and validates `contract_version`.

### C. Shutdown

The wrapper sends a `shutdown` request if supported, waits for a shutdown
acknowledgement, and waits for process exit. If the process does not exit, the
wrapper may terminate it after a timeout.

### D. Restart

The wrapper may restart the bridge if it exits unexpectedly. After restart, the
wrapper must report that pending confirmations were lost. It should run a fresh
`ping` after restart and should not silently retry mutating requests after
restart.

## Timeout Policy

Recommended timeout values:

- startup ping timeout: 3 seconds
- normal request timeout: 10 seconds
- long operation timeout: 30 seconds, only if explicitly allowed in future
- shutdown timeout: 3 seconds

Current bridge operations should be fast and local. Long-running execution is
not part of current bridge scope. Future Codex automation would need a separate
execution queue and timeout policy.

A timeout should produce a clean user-facing error. The wrapper should avoid
duplicate mutation execution after timeout unless idempotency is proven.

## stdout And stderr Policy

stdout:

- protocol-only
- exactly one JSON response line per request
- no human logs
- no stack traces
- no progress text

stderr:

- diagnostics-only
- may be used later for structured logs
- should not be parsed as protocol
- should not leak secrets
- should not be shown raw to end users

If stdout contains non-JSON, the wrapper should treat it as a protocol
violation. If stderr contains diagnostics, the wrapper may store or display a
sanitized summary.

Future timeout, restart, and session-loss diagnostics should follow the stderr
diagnostics contract rather than changing the stdout protocol.
PHASE 10-M adds an optional `DiagnosticWriter`; future wrappers may capture
stderr diagnostics or an injected diagnostics stream when diagnostics are
enabled. That diagnostics capture is separate from stdout protocol parsing.
PHASE 10-N validates capturing stderr diagnostics from subprocess execution
with `--diagnostics-stderr`; non-JSON stdout remains a protocol violation.

## Error Handling Policy

The wrapper should handle:

- invalid JSON response
- missing `bridge_request_id`
- mismatched `bridge_request_id`
- unsupported `contract_version`
- bridge process exits unexpectedly
- request timeout
- shutdown timeout
- normalization errors
- ProjectOps workspace errors
- pending confirmation lost after restart

Rules:

- show a clean user-facing error
- do not show raw stack traces
- do not silently retry mutating actions
- do not treat timeout as success
- do not hide doctor errors
- preserve `bridge_request_id` in logs and diagnostics if possible

## Session-Loss Policy

This is the session loss policy for process restart and crash recovery.
Pending confirmations live only inside the running bridge process. If the
process restarts, pending confirmations are gone.

Future wrappers should notify the user:

```text
The ProjectOps bridge restarted. Pending confirmations were cleared. Please repeat the command if needed.
```

Read-only commands may be retried after restart. Mutating commands should not
be automatically retried unless they were not executed and the user reconfirms.
Verification, final report, and memory operations should be especially careful.

## Idempotency And Retry Policy

Safe to retry automatically after process restart or timeout only if no state
mutation occurred:

- `ping`
- `status`
- `task list`
- `doctor`
- `show task`

Rule: do not auto-retry mutating actions without user confirmation.

Do not auto-retry mutating actions:

- `init workspace`
- `create task`
- `create plan`
- `create worker brief`
- `attach result`
- `verify task`
- `create final report`
- `propose memory update`

Never auto-retry in the current system:

- future high-risk actions
- `auto_run_codex`
- `apply_memory_diff`
- `repair_workspace`
- `delete_artifact`
- `deploy`
- `external_api_action`

## Health Check Policy

`ping` checks bridge process responsiveness. `doctor` checks ProjectOps
workspace health.

The wrapper should use both:

- `ping` for bridge process health
- `doctor` for workspace health

The wrapper should not conflate process health with workspace health. Doctor
errors should be surfaced clearly to the user.

## Workspace Root Policy

The wrapper must pass the correct workspace root to the bridge. It must not
allow arbitrary untrusted root paths without policy.

The wrapper should avoid exposing absolute local paths to remote users and
should treat the root path as sensitive configuration. Future OpenClaw
integration should define how workspace root is selected.

## Security Policy

The stdio bridge is local-only and unauthenticated. The wrapper must own access
control. The bridge must not be exposed over network directly.

The wrapper should control which users can trigger mutating operations and
should use the permission policy before future enforcement. Secrets should not
be sent through payload metadata. Rendered errors should be sanitized.

## Logging And Diagnostics Policy

`bridge_request_id` should be used for bridge-level correlation. `request_id`
should be used for adapter and session-level correlation.

Future wrapper logs should include:

- `bridge_request_id`
- `request_id`
- action
- event_type
- ok
- error_type
- duration

Logs should avoid:

- raw secrets
- full local paths when unnecessary
- raw stack traces to end users

## Recommended Future Wrapper Pseudocode

```text
start bridge
send ping
for each OpenClaw message:
  create bridge_request_id
  send handle_payload
  wait for response with timeout
  validate contract_version
  validate bridge_request_id
  if response ok:
    send rendered text to user
  else:
    send clean error
on shutdown:
  send shutdown
  wait
  terminate if needed
```

## Future Implementation Checklist

- actual OpenClaw payload shape verified
- actual OpenClaw response API verified
- process spawn allowed in target environment
- workspace root selection policy defined
- user identity mapping defined
- permission enforcement policy chosen
- session persistence decision made
- timeout values reviewed
- logging policy reviewed
- tests include restart and session-loss behavior

## Future Work

- local process supervisor prototype
- structured stderr logging
- bridge health checker
- persistent session store
- permission enforcement
- OpenClaw Node wrapper proof of concept
- actual OpenClaw runtime API integration
- safe Codex execution queue
