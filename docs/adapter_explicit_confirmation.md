# Adapter Explicit Confirmation

## Purpose

This document defines the explicit confirmation UX for sensitive adapter
actions. Future wrappers can use it when a sensitive mutating action needs a
stronger confirmation than a plain `yes`.

This is a local Python helper contract. It is not real OpenClaw integration.

## Non-Goals

- not authentication
- not authorization runtime
- not RBAC
- not real OpenClaw integration
- not a server
- not a network protocol
- not execution by itself
- not persistent confirmation storage

## Sensitive Actions

Current sensitive actions:

- `attach_result`
- `verify_task`
- `create_final_report`

These actions are sensitive because they change artifact or task state, can
mark work as verified, failed, or blocked, can complete reports, and may affect
future memory or reporting workflows.

## Confirmation Phrase Contract

The confirmation phrase format is:

```text
confirm {action} {request_id}
```

If `request_id` is unavailable, use:

```text
confirm {action}
```

Examples:

- `confirm verify_task m-123`
- `confirm create_final_report m-456`
- `confirm attach_result`

The action is lowercase. The request id is preserved exactly when present.

## Flow

```text
payload
-> permission preflight
-> explicit confirmation required
-> create_explicit_confirmation_prompt
-> show prompt to user
-> user types exact phrase
-> check_explicit_confirmation
-> wrapper routes original payload with explicit_confirmation=True
```

The helper only builds and checks prompt text. It does not execute actions,
touch files, or call the stdio bridge.

## Future OpenClaw Usage

A future OpenClaw wrapper should:

- detect sensitive action preflight
- return prompt text to the user
- store prompt and session state in the wrapper/session layer
- require the exact phrase
- avoid accepting plain `yes` for sensitive actions
- route only after explicit confirmation passes

## Safety Notes

- Explicit confirmation is not authentication.
- It does not prove identity.
- The caller still owns user identity and access control.
- Do not include secrets or raw payloads in confirmation prompts.
- Do not include unnecessary absolute local paths.
- Do not auto-confirm.
- Do not silently retry sensitive actions.

## Relationship To Permission Preflight

`permission_preflight.py` detects sensitive actions and reports that explicit
confirmation is required. `explicit_confirmation.py` builds and checks the
phrase. `LocalBridgeWrapper` may use both before routing a payload.

Existing runtime behavior remains unchanged unless a future wrapper calls these
helpers. The stdio bridge does not enforce this explicit confirmation contract
by default in this phase.

## Examples

For `verify_task` with request id `m-123`, the phrase is:

```text
confirm verify_task m-123
```

For `create_final_report` with request id `m-456`, the phrase is:

```text
confirm create_final_report m-456
```

If the user types `yes`, the check fails with
`ExplicitConfirmationMismatch`.
