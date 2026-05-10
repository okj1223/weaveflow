# Adapter Permission Preflight

## Purpose

This document defines the local permission preflight layer for future external
wrappers. A wrapper can use this layer before routing raw payloads into the
ProjectOps stdio bridge or local channel adapter.

The preflight classifies the intended adapter action, applies the advisory
permission policy, and returns a `PermissionPreflightResult` that says whether
the wrapper should route, ask for confirmation, ask for explicit confirmation,
or block the request.

## Non-Goals

- not authentication
- not authorization runtime
- not role-based access control
- not real OpenClaw integration
- not a server
- not a network protocol
- not execution
- not persistent policy storage

## Preflight Flow

```text
Raw payload or text
-> normalize if needed
-> intent mapping
-> permission policy
-> PermissionPreflightResult
-> wrapper decides route/confirm/block
```

`preflight_openclaw_payload` normalizes an OpenClaw-like payload, extracts the
message text and request id, and delegates to text preflight.

`preflight_text_command` maps deterministic text commands to adapter requests
or detects preflight-only future high-risk phrases.

`preflight_adapter_request` evaluates an already structured `AdapterRequest`.

## Result Fields

`PermissionPreflightResult` fields:

- `contract_version`
- `ok`
- `source`
- `action`
- `category`
- `allowed`
- `blocked`
- `read_only`
- `mutating`
- `requires_confirmation`
- `requires_explicit_confirmation`
- `should_route`
- `should_ask_confirmation`
- `should_ask_explicit_confirmation`
- `reason`
- `request_id`
- `bridge_request_id`
- `error_type`
- `error_message`
- `metadata`

`ok` means the preflight understood the payload or request enough to produce a
permission decision. `should_route` means a wrapper may route the request to
the bridge or adapter. `blocked` means the wrapper should not route the
request.

## Decision Behavior

- Read-only actions route immediately.
- Safe mutation actions ask for confirmation when `allow_mutation` is false.
- Safe mutation actions route when `allow_mutation` is true.
- Sensitive mutation actions ask for explicit confirmation unless
  `explicit_confirmation` is true.
- Future high-risk actions are blocked.
- Unknown commands are blocked.
- Invalid payloads are blocked.

## Future High-Risk Detection

The preflight layer recognizes these phrases as future high-risk actions and
blocks them before they reach the normal intent mapper:

- `auto run codex`
- `autorun codex`
- `run codex automatically`
- `apply memory diff`
- `repair workspace`
- `delete artifact`
- `edit task history`
- `deploy`
- `call external api`
- `external api action`

These phrases map to policy action names such as `auto_run_codex`,
`apply_memory_diff`, and `external_api_action`. They are preflight-only. They
are not added to the normal intent mapper and are not executable.

## Relationship To Existing Permission Policy

[adapter_permission_policy.md](adapter_permission_policy.md) defines action
classification and `PermissionDecision` behavior. `permission_preflight.py`
applies that policy to text, raw payload, and structured request inputs.

Existing `OpenClawAdapter` and stdio bridge behavior remains unchanged in this
phase. Future wrappers may call preflight before sending `handle_payload` to
the bridge.

`LocalBridgeWrapper` uses this preflight before deciding whether to route a raw
payload to the stdio bridge, route only to establish pending confirmation, ask
for explicit confirmation, or block. See
[local_wrapper_flow.md](local_wrapper_flow.md).

Sensitive actions can use the explicit confirmation helper before routing. See
[adapter_explicit_confirmation.md](adapter_explicit_confirmation.md) for the
`confirm {action} {request_id}` phrase contract.

## Future OpenClaw Wrapper Usage

Future flow:

```text
OpenClaw payload
-> preflight_openclaw_payload
-> if should_route, send to bridge
-> if should_ask_confirmation, ask user
-> if should_ask_explicit_confirmation, ask stronger confirmation
-> if blocked, show clean refusal
-> never route future_high_risk actions
```

## Safety Notes

- Preflight is not an auth boundary.
- Caller still owns user identity and access control.
- Do not expose the bridge over a network.
- Do not silently retry mutating actions.
- Do not auto-run Codex.
- Do not auto-apply memory diffs.
- Do not auto-repair workspace.
