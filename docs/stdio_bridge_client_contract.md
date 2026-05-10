# Stdio Bridge Client Contract

## Purpose

This document defines how a future external process wrapper should communicate
with the ProjectOps stdio bridge.

This is not real OpenClaw integration. This is not a server API. This is not a
network protocol. This is a local subprocess JSON-line contract. Future
OpenClaw integration may use this pattern if an OpenClaw plugin or runtime
needs to call Python ProjectOps locally.

For process lifecycle, restart, timeout, stdout, and stderr policy, see
[stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md).
This client contract defines protocol usage; the supervision document defines
lifecycle and restart policy.
For future structured stderr diagnostics, see
[stdio_bridge_diagnostics_contract.md](stdio_bridge_diagnostics_contract.md).
For lightweight ping health check helpers, see
[stdio_bridge_health_checks.md](stdio_bridge_health_checks.md).

## Non-Goals

- no real OpenClaw import
- no OpenClaw API calls
- no bot
- no server
- no network listener
- no webhook
- no persistent session store
- no authentication runtime
- no authorization runtime
- no external APIs
- no auto-running Codex

## Process Model

A future external wrapper spawns the Python bridge process. The bridge reads
stdin line by line and writes stdout line by line. One request line produces one
response line.

Keeping the process alive preserves the bridge's in-memory `AdapterSession`
state, including pending confirmations. Killing the process loses in-memory
pending confirmations. ProjectOps task state remains durable because
`.projectops` files and SQLite remain the source of truth.

The wrapper must never parse human-readable output from the bridge. Bridge
stdout is reserved for JSON response lines.

## Recommended Command

Use the module entrypoint:

```bash
python3 -m projectops.adapters.stdio_bridge --root /path/to/project
```

This does not add an `ops` CLI command. The module entrypoint calls
`run_stdio_bridge(root, sys.stdin, sys.stdout)`.

Client wrappers may opt into structured stderr diagnostics with:

```bash
python3 -m projectops.adapters.stdio_bridge --root /path/to/project --diagnostics-stderr
```

When that flag is used, stdout and stderr must be consumed separately: stdout
is still the request/response protocol, while stderr carries diagnostic JSON
lines.

## Request And Response Flow

The bridge protocol is documented in
[stdio_bridge_protocol.md](stdio_bridge_protocol.md). Client wrappers should
send one line-delimited JSON request per operation and read one line-delimited
JSON response.

Supported request types:

- `ping`: verify the subprocess is responding.
- `handle_payload`: pass an OpenClaw-like raw payload into the local channel
  adapter path.
- `shutdown`: ask the bridge to acknowledge shutdown and exit cleanly.

`bridge_request_id` is the caller's correlation id. The bridge copies it into
the response when the request can be parsed.

Before normal request handling, a wrapper may run the health check helper to
send `ping`, validate the stdout response shape, optionally validate stderr
diagnostics, and produce a clean summary if the bridge is not ready.

Before sending `handle_payload`, a wrapper may also run permission preflight
where feasible. The local preflight helper is documented in
[adapter_permission_preflight.md](adapter_permission_preflight.md); it classifies
the intended action and returns whether the wrapper should route, ask for
confirmation, require explicit confirmation, or block.

## Future OpenClaw Wrapper Responsibilities

A future OpenClaw-side wrapper should:

- spawn the bridge process
- send line-delimited JSON requests
- preserve `bridge_request_id`
- route OpenClaw payloads into `handle_payload` requests
- run permission preflight before routing unsafe or mutating payloads where
  feasible
- keep the process alive per workspace or configured scope
- handle `shutdown`
- restart the process only with clear user-visible session loss
- never expose the bridge directly to a network
- never treat the bridge as an authentication boundary
- never parse human-readable text

## Error Handling

Invalid JSON returns a JSON error response. A wrong `contract_version` returns a
JSON error response. A malformed payload returns a JSON error response from the
`handle_payload` path.

Bridge stdout should remain JSON-only. A wrapper should parse stdout as JSON,
show clean user-facing errors, and avoid exposing raw stack traces.
Future client wrappers should capture stderr separately from stdout and should
not parse stderr as the request/response protocol.
If `--diagnostics-stderr` is enabled, those stderr lines should be parsed as
diagnostics rather than protocol responses.

## Session Implications

One running bridge process owns one `OpenClawAdapter`, and therefore one
in-memory session store. Pending confirmations live only inside that process.

A future persistent session store is separate future work. ProjectOps task
state survives process restarts because it lives in `.projectops/` and SQLite.
Confirmation prompts may be lost on process restart.

## Security Notes

- The bridge is local-only.
- The bridge is unauthenticated.
- Do not expose it directly to a network.
- The caller must enforce access control.
- The caller must control the workspace root.
- The caller must avoid leaking local paths.
- Sensitive and future high-risk operations remain future-gated by policy.

## Minimal Pseudo-Code

```text
spawn bridge: python3 -m projectops.adapters.stdio_bridge --root /path/to/project
send ping
read ping response
send status handle_payload request
read completed status response
send init workspace handle_payload request
read pending confirmation response
send yes handle_payload request
read completed init response
send shutdown
read shutdown response
```

## Future Work

- real OpenClaw plugin wrapper
- Node subprocess manager
- persistent session store
- auth and user mapping
- permission enforcement
- bridge health checks
- structured logging to stderr
- process restart strategy
