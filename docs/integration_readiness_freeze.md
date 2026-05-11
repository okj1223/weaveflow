# Integration Readiness Freeze

## Purpose

This document freezes the current local Weaveflow and OpenClaw-preparation
architecture before real integration work begins.

It answers what exists, what is stable enough, what remains intentionally
local-only, what is blocked before a real OpenClaw proof of concept, what
should not be built yet, and where the current architecture-building loop
should stop.

This is no real OpenClaw integration. It does not import OpenClaw, call
OpenClaw APIs, create a bot, add a server, or add a network surface.

## Current Completed Layers

The repository now has these local Weaveflow layers:

- Weaveflow core workflow
- task specs
- plans
- Codex worker briefs
- artifacts
- verification records
- reports
- memory diffs
- doctor
- JSON output
- JSON schemas
- service boundary
- adapter request/response
- intent mapper
- confirmation flow
- adapter session
- adapter events
- renderers
- channel rendering
- OpenClaw placeholder skeleton
- payload normalization
- stdio bridge
- stdio client contract
- diagnostics
- health checks
- permission preflight
- explicit confirmation
- replay protection
- wrapper notifications
- local wrapper flow

The `.weaveflow` files and SQLite remain the source of truth for Weaveflow
task state. Wrapper records, rendered text, notifications, and transcripts are
review or interaction artifacts only.

## What Is Stable Enough

The current repository is stable enough for a local proof of concept because:

- the full test suite is passing
- git commits exist for the local architecture layers
- `.weaveflow` runtime state is ignored by git
- docs exist for the major contracts
- the stdio bridge can be spawned by a future external process
- the stdio bridge preserves stdout as protocol JSON
- diagnostics, health checks, and wrapper notifications are documented and
  covered by tests
- the local wrapper flow demonstrates the safety policy around permission
  preflight, normal confirmation, explicit confirmation, replay protection,
  notification rendering, and transcript review artifacts

Stable enough does not mean production-ready. It means there is enough local
surface area to test one narrow real integration proof of concept.

## What Remains Intentionally Local-Only

These parts are deliberately local-only:

- sessions are in-memory
- normal confirmations are in-memory
- explicit confirmations are in-memory
- replay protection is in-memory
- wrapper transcripts are local review artifacts
- there is no auth
- there is no RBAC
- there is no authentication runtime
- there is no authorization runtime
- there is no real OpenClaw runtime
- there is no server
- there are no external APIs
- there is no persistent process supervision
- there are no persistent sessions

The current implementation should not pretend to be an auth boundary, a
production process manager, or a durable session authority.

## Blockers Before Real OpenClaw Integration

Concrete blockers remain before real OpenClaw integration:

- verify the actual OpenClaw plugin/runtime extension mechanism
- verify the actual OpenClaw payload and reply shape
- decide Python subprocess bridge versus OpenClaw-native plugin behavior
- define workspace root selection policy
- define user identity mapping
- decide whether to persist sessions or accept in-memory sessions
- define the permission enforcement boundary
- define production logging and sanitization policy
- decide whether the real integration should use the stdio bridge or another
  surface

These decisions require evidence from a working OpenClaw checkout or current
official OpenClaw runtime documentation, not another speculative local wrapper
layer.

## What Should Not Be Built Yet

Do not build these yet:

- persistent sessions
- auth/RBAC
- process supervisor
- real OpenClaw plugin
- Codex auto-execution
- memory auto-apply
- workspace repair automation
- deployment integration
- external API actions
- web UI

These should wait until the actual OpenClaw integration surface is verified.
Building them now would harden guesses before the runtime boundary is known.

## Recommended Smallest Future POC

The smallest future POC should be a real external wrapper that does only this:

```text
spawn Weaveflow stdio bridge
send ping
send status payload
send create task payload
receive pending confirmation
send yes
receive completed response
send task list
shutdown bridge
```

This POC should not:

- auto-run Codex
- verify tasks
- attach files
- apply memory
- repair workspace
- persist sessions

The goal is to validate the real OpenClaw process/tool boundary and reply path,
not to expand Weaveflow runtime behavior.

## Stop Criteria

Stop architecture-building phases when:

- full test suite passes
- `weaveflow doctor` is healthy
- git status is clean
- `integration_readiness_freeze.md` exists
- README links to it
- the smallest future POC is clearly defined
- no new local-only safety layer is necessary before real OpenClaw API
  verification

These stop criteria are met when the freeze document is committed, tests pass,
Weaveflow health is clean, and the repository has no uncommitted
commit-worthy changes.

## Recommended Next Human Action

Recommended action:

- stop feeding Codex more speculative adapter phases
- review `docs/integration_readiness_freeze.md`
- inspect git log
- decide whether to:
  A. pause and preserve the repository
  B. research actual OpenClaw plugin implementation deeply
  C. build a minimal real POC in a separate branch
  D. package Weaveflow as a local tool first

The next decision should be made by a human after reviewing the freeze, not by
continuing the local architecture loop.

## Next Phase Recommendation

The next phase should not be another generic adapter layer.

Recommended options:

- PHASE 11-B: create a release tag and changelog
- PHASE 12-A: real OpenClaw plugin POC research branch
- PHASE 12-B: package Weaveflow as a local Python tool
- STOP: pause architecture work

Do not recommend another speculative safety wrapper unless a real integration
gap demands it.
