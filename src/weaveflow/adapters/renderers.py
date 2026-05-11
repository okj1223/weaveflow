"""Plain-text renderers for adapter events and transcripts."""

from __future__ import annotations

from typing import Any

from weaveflow.adapters.events import AdapterEvent, AdapterTranscript


SUPPORTED_RENDER_STYLES = {"chat", "log"}


def render_event_as_text(event: AdapterEvent, style: str = "chat") -> str:
    if style not in SUPPORTED_RENDER_STYLES:
        raise ValueError(f"Unknown adapter render style: {style}")
    if style == "log":
        return _render_event_log(event)
    return _render_event_chat(event)


def render_transcript_as_text(
    transcript: AdapterTranscript,
    style: str = "chat",
) -> str:
    if style not in SUPPORTED_RENDER_STYLES:
        raise ValueError(f"Unknown adapter render style: {style}")
    lines = [
        f"Adapter transcript: {transcript.session_id}",
        f"Event count: {len(transcript.events)}",
    ]
    lines.extend(render_event_as_text(event, style=style) for event in transcript.events)
    return "\n".join(lines)


def render_event_summary(event: AdapterEvent) -> str:
    action = event.action or "none"
    return f"{event.state} action={action} request_id={event.request_id}"


def _render_event_chat(event: AdapterEvent) -> str:
    action = event.action or "unknown action"
    detail = _important_detail(event)
    if event.event_type == "turn_completed":
        line = f"✅ Completed: {action}"
    elif event.event_type == "pending_confirmation":
        line = f"⚠️ Confirmation required: {action}"
    elif event.event_type == "turn_rejected":
        line = f"🚫 Rejected: {action}"
    elif event.event_type == "turn_error":
        label = event.error_type or "Error"
        line = f"❌ Error: {label}"
        if action != "unknown action":
            line = f"{line} ({action})"
    else:
        line = f"{event.level.upper()}: {action}"

    parts = [line]
    if event.message:
        parts.append(event.message)
    if detail:
        parts.append(detail)
    if event.event_type == "pending_confirmation":
        parts.append(
            f"Request ID: {event.request_id}. Confirm or reject this request in the external UI."
        )
    elif event.event_type != "turn_completed":
        parts.append(f"Request ID: {event.request_id}")
    return "\n".join(parts)


def _render_event_log(event: AdapterEvent) -> str:
    level = {
        "info": "INFO",
        "warning": "WARN",
        "error": "ERROR",
    }.get(event.level, event.level.upper())
    action = event.action if event.action is not None else "None"
    fields = [
        f"[{level}]",
        event.state,
        f"event_type={event.event_type}",
        f"action={action}",
        f"request_id={event.request_id}",
    ]
    if event.error_type:
        fields.append(f"error_type={event.error_type}")
    return " ".join(fields)


def _important_detail(event: AdapterEvent) -> str:
    response = event.data.get("response")
    if not isinstance(response, dict):
        return ""
    data = response.get("data")
    if not isinstance(data, dict):
        return ""

    detail_parts: list[str] = []
    for key, label in [
        ("id", "Task"),
        ("count", "Task count"),
        ("workspace_exists", "Workspace exists"),
        ("healthy", "Workspace healthy"),
    ]:
        if key in data:
            detail_parts.append(f"{label}: {_safe_scalar(data[key])}")

    if detail_parts:
        return " | ".join(detail_parts)
    return ""


def _safe_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)) or value is None:
        return str(value)
    return ""
