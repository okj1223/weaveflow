# Wrapper Result Rendering

## Purpose

This document defines how local wrapper routing results and wrapper
notifications should be rendered for future channel surfaces.

`LocalBridgeWrapper` produces structured routing records. Future channel
wrappers can render those records as concise plain text before sending a
message to an OpenClaw, Slack, Telegram, terminal, or log surface.

This is local-only rendering. It is not real OpenClaw integration.

## Non-Goals

- not real OpenClaw integration
- not a bot
- not a server
- not a network protocol
- not rich UI rendering
- not authentication
- not authorization
- not execution
- not source of truth

## Rendering Inputs

The rendering helpers accept:

- `WrapperRouteResult`: the local wrapper routing decision and optional bridge
  response.
- `WrapperNotification`: a user-facing warning or notice, such as session loss
  or stale confirmation replay.

## Rendering Outputs

Rendering outputs are presentation-only:

- concise plain text for chat and terminal surfaces
- single-line plain text for log surfaces
- JSON-safe payloads for tests and future wrapper diagnostics

Rendered text must not be treated as source of truth.

## Rendering Cases

Routed result:

- mention that the payload was routed
- include the action when known
- include the route reason
- include the bridge `event_type` when present

Pending confirmation result:

- mention `pending_confirmation`
- tell the user to reply `yes` or `no`
- avoid implying that the mutation completed

Explicit confirmation required result:

- mention explicit confirmation
- include the exact instruction or confirmation phrase when available
- avoid implying execution occurred

Blocked future-high-risk result:

- mention blocked
- include the action
- state that future high-risk actions are not supported

Invalid payload or mapping error:

- include the safe `error_type`
- include a clean summary or error message
- avoid raw stack traces

Notifications:

- stale confirmation notification
- mismatch notification
- missing confirmation notification
- session-loss notification

Notifications may be rendered directly or as part of
`WrapperRouteResult.metadata["notification"]`.

## Channel Policy

Supported channels:

- `openclaw`
- `slack`
- `telegram`
- `terminal`
- `log`

A future OpenClaw wrapper should call
`render_wrapper_result_as_text(result, channel="openclaw")`.

Operator logs should use `channel="log"` or `render_wrapper_result_summary`.

Rendered text is presentation-only and is not the source of truth.

## Source Of Truth

`.projectops` files and SQLite remain the task source of truth.

`WrapperRouteResult` is a routing result. `WrapperNotification` is a
user-facing warning or notice. Rendered text is a communication artifact only.

## Future OpenClaw Usage

Future flow:

```text
OpenClaw payload
-> LocalBridgeWrapper.handle_payload
-> WrapperRouteResult
-> render_wrapper_result_as_text(channel="openclaw")
-> send text to user
```

For stale, replay, or session-loss notices:

```text
WrapperNotification
-> render_wrapper_notification_for_channel(channel="openclaw")
-> send text to user
```

## Safety Notes

- Renderers must not hide errors.
- Renderers must not imply execution when `routed` is false.
- Renderers must not auto-confirm.
- Renderers must not leak unnecessary absolute local paths.
- Renderers must not expose raw stack traces.
- Renderers must not execute actions, mutate files, call the bridge, or call
  external APIs.

## Helpers

- `render_wrapper_result_as_text`
- `render_wrapper_notification_for_channel`
- `render_wrapper_result_summary`
- `render_wrapper_result_payload`
