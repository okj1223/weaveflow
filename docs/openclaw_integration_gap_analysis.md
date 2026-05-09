# OpenClaw Integration Gap Analysis

## Purpose

This document compares the ProjectOps local OpenClaw skeleton with findings
from the real OpenClaw runtime research.

The comparison is meant to guide the next implementation phase without
implementing real OpenClaw integration.

## Current ProjectOps Skeleton

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
create a bot, add a server, or modify ProjectOps core workflow behavior.

## What Aligns Well

- OpenClaw uses channel, user, session, and thread concepts; ProjectOps already
  models channel-like payloads with channel, user, message, and optional thread
  fields.
- OpenClaw treats the Gateway as the source of truth for sessions and channel
  connections; ProjectOps treats `.projectops` files and SQLite as the source
  of truth for ProjectOps task state.
- OpenClaw has explicit security controls for DMs, groups, pairing, allowlists,
  roles, and scopes; ProjectOps has started an advisory permission policy for
  read-only, safe mutating, sensitive mutating, and future high-risk actions.
- OpenClaw supports skills and plugin-registered tools; ProjectOps already has
  a structured adapter pipeline that can be exposed as a tool boundary later.
- OpenClaw separates channel surfaces from Gateway/client control. ProjectOps
  similarly separates channel-like payload normalization from
  `ProjectOpsServiceAdapter` execution.
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
- The real Gateway protocol may require a WebSocket client if ProjectOps chooses
  a Gateway-client integration path.
- Real plugin and skill implementation appears to be TypeScript/Node oriented;
  ProjectOps is Python and likely needs a subprocess bridge.
- Current ProjectOps permission policy is advisory and not enforced in
  `OpenClawAdapter`.
- Channel rendering redaction is simple and not a full secret redaction system.
- The skeleton `handle_payload` method is useful for local smoke tests but is
  not evidence of the real OpenClaw API contract.

## Integration Risk Table

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Payload mismatch | High | Medium | Do not treat placeholder payloads as production. Verify real plugin tool or channel payload types before implementation. |
| Auth/scope mismatch | High | High | Map ProjectOps permission policy to OpenClaw role/scope and plugin policy only after a proof of concept. |
| Session mismatch | Medium | High | Reuse OpenClaw session identifiers where possible; avoid inventing an independent task-state session authority. |
| Confirmation UX mismatch | Medium | Medium | Keep confirmation as explicit text first; add buttons or richer UI only after channel behavior is verified. |
| Real OpenClaw API instability | Medium | Medium | Pin against a documented version and keep ProjectOps bridge narrow. |
| Python/Node boundary complexity | High | Medium | Prefer a stdio JSON bridge with strict schemas, timeouts, and clean error handling. |
| Security issue from chat-triggered mutations | Medium | High | Require confirmation, add explicit confirmation for sensitive actions, and block future high-risk actions. |
| Local path exposure | Medium | Medium | Keep channel rendering redaction and avoid returning unnecessary absolute paths. |
| Process management | Medium | Medium | Add subprocess timeout, exit-code, and stderr policy in a bridge phase before real OpenClaw integration. |
| Test environment complexity | Medium | Medium | Start with local bridge tests, then add a minimal OpenClaw plugin proof-of-concept test harness. |

## Recommended Next Phase

Primary recommendation: PHASE 10-I should add a local stdio JSON bridge for the
ProjectOps adapter pipeline.

Why this path:

- It is useful even before real OpenClaw integration.
- It gives a future OpenClaw plugin a stable subprocess contract.
- It keeps ProjectOps Python runtime independent from OpenClaw's Node runtime.
- It can reuse `AdapterSession`, permission policy, `AdapterEvent`, and
  renderer outputs without guessing OpenClaw payload shapes.
- It avoids implementing a Gateway WebSocket client before auth, scope, and
  reply mechanics are verified.

Alternative: PHASE 10-I could be an OpenClaw skill/plugin API proof-of-concept
design if the team wants to validate Node-side plugin shape first.

Do not jump straight to production integration.

## Blockers Before Real Integration

- Confirm the current OpenClaw plugin tool API with a working OpenClaw checkout.
- Confirm the exact plugin input/output model for tool calls.
- Confirm how a tool result is rendered back to the user and whether it can
  preserve `request_id`.
- Confirm how OpenClaw represents channel/user/account/thread/session keys.
- Confirm whether ProjectOps needs a plugin-specific operator scope.
- Confirm how to package or configure a local ProjectOps bridge in OpenClaw.
- Confirm subprocess timeout, environment, cwd, and path safety rules.
- Confirm how to test the integration locally without a real Slack/Telegram
  bot.
- Confirm whether sensitive ProjectOps actions need a richer explicit
  confirmation UX in OpenClaw.

## Decision Record

Current decision: Do not integrate real OpenClaw yet.

First build a narrow bridge or proof of concept aligned with a confirmed
runtime surface.

Reason: Avoid coupling ProjectOps to guessed payloads or unstable undocumented
APIs.
