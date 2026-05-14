# OpenClaw Integration Gap Analysis

## Purpose

This document compares the Weaveflow local OpenClaw skeleton with findings
from the real OpenClaw runtime research.

The comparison is meant to guide the next implementation phase without
implementing real OpenClaw integration.

Historical note: this document was written before the current branch added the
OpenClaw + Codex job runner personal automation experiment. Its "future" and
"not yet" language should be read as core MVP / early POC scope, not as a
global current-project prohibition. The current direction is documented in
[personal_automation_direction.md](personal_automation_direction.md).

The current local architecture is frozen for readiness review in
[integration_readiness_freeze.md](integration_readiness_freeze.md). That
freeze defines the stop criteria and the smallest future real OpenClaw proof of
concept.

## Current Weaveflow Skeleton

Current local pieces:

- `OpenClawMessage` placeholder model
- `OpenClawResponse` placeholder model
- `normalize_openclaw_message_payload`
- `openclaw_response_to_payload`
- `OpenClawAdapter`
- `OpenClawSessionStore` / `AdapterSessionStore`
- `AdapterSession`
- advisory permission policy
- channel rendering policy
- `handle_payload` local smoke flow

The skeleton is local-only. It does not import OpenClaw, call OpenClaw APIs,
create a bot, add a server, or modify Weaveflow core workflow behavior.

## What Aligns Well

- OpenClaw uses channel, user, session, and thread concepts; Weaveflow already
  models channel-like payloads with channel, user, message, and optional thread
  fields.
- OpenClaw treats the Gateway as the source of truth for sessions and channel
  connections; Weaveflow treats `.weaveflow` files and SQLite as the source
  of truth for Weaveflow task state.
- OpenClaw has explicit security controls for DMs, groups, pairing, allowlists,
  roles, and scopes; Weaveflow has started an advisory permission policy for
  read-only, safe mutating, sensitive mutating, and future high-risk actions.
- OpenClaw supports skills and plugin-registered tools; Weaveflow already has
  a structured adapter pipeline that can be exposed as a tool boundary later.
- OpenClaw separates channel surfaces from Gateway/client control. Weaveflow
  similarly separates channel-like payload normalization from
  `WeaveflowServiceAdapter` execution.
- Confirmation flow is a good fit for chat-like surfaces where mutating actions
  must not execute silently.
- Channel-specific rendering aligns with OpenClaw's multi-channel nature.

## What Likely Does Not Align Yet

- Placeholder `OpenClawMessage` may not match the real OpenClaw channel plugin
  payload shape.
- Placeholder `OpenClawResponse` may not match the real reply mechanism for a
  plugin tool, channel plugin, or Gateway client.
- Session ownership may differ because OpenClaw can scope DMs by main,
  per-peer, per-channel-peer, per-account-channel-peer, group, room, webhook,
  cron, and thread bindings.
- Auth/scope handling is missing. Real Gateway clients negotiate roles and
  scopes, and plugins can be controlled by allow/deny policy.
- The real Gateway protocol may require a WebSocket client if Weaveflow chooses
  a Gateway-client integration path.
- Real plugin and skill implementation appears to be TypeScript/Node oriented;
  Weaveflow is Python and likely needs a subprocess bridge.
- Current Weaveflow permission policy is advisory and not enforced in
  `OpenClawAdapter`.
- Channel rendering redaction is simple and not a full secret redaction system.
- The skeleton `handle_payload` method is useful for local smoke tests but is
  not evidence of the real OpenClaw API contract.

## Integration Risk Table

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Payload mismatch | High | Medium | Do not treat placeholder payloads as production. Verify real plugin tool or channel payload types before implementation. |
| Auth/scope mismatch | High | High | Map Weaveflow permission policy to OpenClaw role/scope and plugin policy only after a proof of concept. |
| Session mismatch | Medium | High | Reuse OpenClaw session identifiers where possible; avoid inventing an independent task-state session authority. |
| Confirmation UX mismatch | Medium | Medium | Keep confirmation as explicit text first; add buttons or richer UI only after channel behavior is verified. |
| Real OpenClaw API instability | Medium | Medium | Pin against a documented version and keep Weaveflow bridge narrow. |
| Python/Node boundary complexity | High | Medium | Prefer a stdio JSON bridge with strict schemas, timeouts, and clean error handling. |
| Security issue from chat-triggered mutations | Medium | High | Require confirmation, add explicit confirmation for sensitive actions, and block future high-risk actions. |
| Local path exposure | Medium | Medium | Keep channel rendering redaction and avoid returning unnecessary absolute paths. |
| Process management | Medium | Medium | Add subprocess timeout, exit-code, and stderr policy in a bridge phase before real OpenClaw integration. |
| Test environment complexity | Medium | Medium | Start with local bridge tests, then add a minimal OpenClaw plugin proof-of-concept test harness. |

## Historical Readiness Freeze

PHASE 11-A freezes the local architecture-building loop before real OpenClaw
work. See [integration_readiness_freeze.md](integration_readiness_freeze.md)
for what exists, what is stable enough, what remains local-only, what is
blocked, and what should not be built yet.

The smallest proof of concept recommended at that time was to spawn the stdio bridge, send
`ping`, send `status`, create one task with confirmation, list tasks, and shut
down. It should not add Codex auto-execution, persistent sessions, auth/RBAC,
or external API actions. That was a deliberate POC constraint, not a current
global rule for the whole branch.

## Prior Recommended Next Phase

Primary recommendation: PHASE 10-I should add a local stdio JSON bridge, also
called the stdio bridge, for the Weaveflow adapter pipeline.

That bridge is now defined in
[stdio_bridge_protocol.md](stdio_bridge_protocol.md). It is a local process
bridge, not real OpenClaw integration.

The next wrapper-facing step is documented in
[stdio_bridge_client_contract.md](stdio_bridge_client_contract.md). It explains
how a future OpenClaw Node process wrapper should spawn the Weaveflow bridge,
send JSON lines, preserve `bridge_request_id`, and keep the process alive for
in-memory sessions.

Process supervision is a prerequisite before real OpenClaw plugin work. See
[stdio_bridge_process_supervision.md](stdio_bridge_process_supervision.md) for
restart, timeout, stdout, stderr, and session-loss policy.
Structured stderr diagnostics are also a prerequisite for robust wrapper
supervision. See
[stdio_bridge_diagnostics_contract.md](stdio_bridge_diagnostics_contract.md)
for the diagnostics contract.
Bridge health checks are another prerequisite for a future wrapper. See
[stdio_bridge_health_checks.md](stdio_bridge_health_checks.md) for the local
ping preflight and stdout/stderr validation helpers.

Why this path:

- It is useful even before real OpenClaw integration.
- It gives a future OpenClaw plugin a stable subprocess contract.
- It keeps Weaveflow Python runtime independent from OpenClaw's Node runtime.
- It can reuse `AdapterSession`, permission policy, `AdapterEvent`, and
  renderer outputs without guessing OpenClaw payload shapes.
- It avoids implementing a Gateway WebSocket client before auth, scope, and
  reply mechanics are verified.
- Permission preflight is a prerequisite for future wrapper safety because it
  lets a wrapper classify actions and block future high-risk requests before
  sending payloads to the bridge.
- The local wrapper smoke flow in [local_wrapper_flow.md](local_wrapper_flow.md)
  combines health checks, permission preflight, and stdio routing before real
  OpenClaw integration.

Alternative: PHASE 10-I could be an OpenClaw skill/plugin API proof-of-concept
design if the team wants to validate Node-side plugin shape first.

For the current personal automation layer, the priority is practical
reliability, observability, recovery, and cost/time efficiency before broader
productization.

## Blockers Before Real Integration

- Confirm the current OpenClaw plugin tool API with a working OpenClaw checkout.
- Confirm the exact plugin input/output model for tool calls.
- Confirm how a tool result is rendered back to the user and whether it can
  preserve `request_id`.
- Confirm how OpenClaw represents channel/user/account/thread/session keys.
- Confirm whether Weaveflow needs a plugin-specific operator scope.
- Confirm how to package or configure a local Weaveflow bridge in OpenClaw.
- Confirm subprocess timeout, environment, cwd, and path safety rules.
- Confirm how to test the integration locally without a real Slack/Telegram
  bot.
- Confirm whether sensitive Weaveflow actions need a richer explicit
  confirmation UX in OpenClaw.

## Decision Record

Historical decision: do not integrate real OpenClaw yet at the skeleton stage.

First build a narrow bridge or proof of concept aligned with a confirmed
runtime surface.

Reason: Avoid coupling Weaveflow to guessed payloads or unstable undocumented
APIs.

Current branch note: the repository now contains a native OpenClaw plugin POC
and Codex job runner tools for personal automation. Remaining gaps should be
framed around trust, job UX, recovery, and safe automation policy rather than
whether any OpenClaw/Codex automation may exist at all.
