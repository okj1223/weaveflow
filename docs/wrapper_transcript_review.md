# Wrapper Transcript Review

## Purpose

Wrapper transcripts are local review artifacts for future external adapter
flows. They capture the path from an external-style payload through permission
preflight, `LocalBridgeWrapper` routing, optional wrapper notifications, and
rendered channel text.

This prepares future OpenClaw review and debug workflows without integrating
real OpenClaw.

## Non-Goals

- not real OpenClaw integration
- not persistent storage
- not source of truth
- not a server
- not a bot
- not authentication
- not authorization
- not audit-grade logging
- not secret redaction

## What A Transcript Captures

`WrapperTranscriptEntry` records one wrapper turn:

- payload summary after lightweight sanitization
- permission preflight payload when available
- route result payload when available
- notification payload when present
- rendered text for the selected channel
- action, category, routed, blocked, ok, and error fields
- request correlation fields such as `request_id` and `bridge_request_id`

`WrapperTranscript` groups entries for one local smoke or review run. The
transcript is JSON-safe and intended for local inspection.

## Source Of Truth

`.weaveflow` files and SQLite remain the source of truth for task state.

A transcript is a review and debug artifact only. Rendered text is
presentation-only. Wrapper notifications are user-facing hints, not durable
task state. Future wrappers must not treat a `WrapperTranscript` as task
storage or as confirmation/session storage.

## Future OpenClaw Usage

A future OpenClaw wrapper may use transcripts to:

- debug message handling
- review permission decisions
- compare payloads with rendered output
- generate local integration test fixtures
- inspect why a command was routed, blocked, or held for confirmation

It should not use transcripts as durable task state and should not persist them
without a separate storage, retention, and privacy policy.

## Safety Notes

- sanitize payloads before recording them
- avoid secrets and raw credentials
- avoid full raw payload dumps by default
- redact local paths where practical
- do not expose transcripts to untrusted users without review
- remember this is not full secret redaction

## Example Flow

```text
status
-> preflight read-only
-> route result routed
-> rendered text
-> WrapperTranscriptEntry

create task Demo
-> preflight safe mutation
-> route result pending_confirmation
-> rendered text asks yes/no
-> WrapperTranscriptEntry

yes
-> route result turn_completed
-> rendered text
-> WrapperTranscriptEntry

verify TASK-0001 passed manual check
-> preflight sensitive mutation
-> route result explicit_confirmation_required
-> rendered text includes exact phrase
-> WrapperTranscriptEntry

yes
-> mismatch or bridge confirmation result depending on pending state
-> notification if present
-> WrapperTranscriptEntry

auto run codex
-> preflight future_high_risk
-> route result blocked
-> rendered text
-> WrapperTranscriptEntry

bad payload
-> normalization error
-> route result blocked
-> rendered text
-> WrapperTranscriptEntry
```

## JSON And Markdown Outputs

`transcript_to_json` returns a valid JSON string for machine review.

`transcript_to_markdown` returns a concise human-readable review artifact with
the transcript id, channel, entry count, and each entry's label, action,
category, routed, blocked, ok, error type, and rendered text.

`run_payloads_with_transcript` is a local smoke helper. It does not auto-confirm
mutations, does not auto-run sensitive actions, does not call external APIs, and
does not integrate OpenClaw.
