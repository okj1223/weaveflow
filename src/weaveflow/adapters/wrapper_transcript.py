"""Local review transcripts for wrapper routing flows."""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from weaveflow.adapters.diagnostics import sanitize_diagnostic_metadata
from weaveflow.adapters.local_wrapper import LocalBridgeWrapper, WrapperRouteResult
from weaveflow.adapters.permission_preflight import (
    PermissionPreflightResult,
    permission_preflight_result_to_payload,
    preflight_openclaw_payload,
)
from weaveflow.adapters.wrapper_rendering import (
    render_wrapper_result_as_text,
    render_wrapper_result_payload,
)
from weaveflow.json_io import CONTRACT_VERSION, to_jsonable
from weaveflow.models import utc_now_iso


class WrapperTranscriptEntry(BaseModel):
    contract_version: str = CONTRACT_VERSION
    entry_id: str
    created_at: str
    channel: str
    label: str
    payload: dict[str, Any]
    preflight: Optional[dict[str, Any]] = None
    route_result: Optional[dict[str, Any]] = None
    notification: Optional[dict[str, Any]] = None
    rendered_text: str
    bridge_request_id: Optional[str] = None
    request_id: Optional[str] = None
    action: Optional[str] = None
    category: Optional[str] = None
    routed: bool
    blocked: bool
    ok: bool
    error_type: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class WrapperTranscript(BaseModel):
    contract_version: str = CONTRACT_VERSION
    transcript_id: str = Field(default_factory=lambda: str(uuid4()))
    created_at: str = Field(default_factory=utc_now_iso)
    channel: str
    entries: list[WrapperTranscriptEntry] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    def add_entry(self, entry: WrapperTranscriptEntry) -> None:
        self.entries.append(entry)

    def to_dict(self) -> dict[str, Any]:
        payload = to_jsonable(self)
        if not isinstance(payload, dict):
            raise TypeError("WrapperTranscript did not serialize to a dictionary.")
        return payload


def sanitize_transcript_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON-safe, lightly redacted copy of a raw payload."""

    jsonable = to_jsonable(dict(payload))
    if not isinstance(jsonable, dict):
        jsonable = {"value": jsonable}
    return sanitize_diagnostic_metadata(jsonable)


def create_wrapper_transcript_entry(
    *,
    label: str,
    channel: str,
    payload: dict[str, Any],
    preflight: Optional[PermissionPreflightResult] = None,
    route_result: Optional[WrapperRouteResult] = None,
    rendered_text: str = "",
    metadata: Optional[dict[str, Any]] = None,
) -> WrapperTranscriptEntry:
    """Create one JSON-safe transcript entry without executing anything."""

    preflight_payload = _preflight_payload(preflight)
    route_payload = _route_payload(route_result)
    notification = _notification_payload(route_payload)

    bridge_request_id = _first_string(
        _from_route(route_result, "bridge_request_id"),
        _from_mapping(preflight_payload, "bridge_request_id"),
    )
    request_id = _first_string(
        _from_mapping(preflight_payload, "request_id"),
        _from_mapping(notification, "request_id"),
    )
    action = _first_string(
        _from_route(route_result, "action"),
        _from_mapping(preflight_payload, "action"),
    )
    category = _first_string(
        _from_route(route_result, "category"),
        _from_mapping(preflight_payload, "category"),
    )
    routed = bool(route_result.routed) if route_result is not None else False
    blocked = bool(route_result.blocked) if route_result is not None else False
    ok = bool(route_result.ok) if route_result is not None else bool(
        preflight.ok if preflight is not None else False
    )
    error_type = _first_string(_from_route(route_result, "error_type"))
    if error_type is None and route_result is None:
        error_type = _first_string(_from_mapping(preflight_payload, "error_type"))

    return WrapperTranscriptEntry(
        entry_id=str(uuid4()),
        created_at=utc_now_iso(),
        channel=channel,
        label=label,
        payload=sanitize_transcript_payload(payload),
        preflight=preflight_payload,
        route_result=route_payload,
        notification=notification,
        rendered_text=rendered_text,
        bridge_request_id=bridge_request_id,
        request_id=request_id,
        action=action,
        category=category,
        routed=routed,
        blocked=blocked,
        ok=ok,
        error_type=error_type,
        metadata=sanitize_diagnostic_metadata(metadata or {}),
    )


def transcript_to_json(transcript: WrapperTranscript) -> str:
    """Serialize a wrapper transcript as valid JSON."""

    return json.dumps(transcript.to_dict(), indent=2, sort_keys=True)


def transcript_to_markdown(transcript: WrapperTranscript) -> str:
    """Render a concise human-readable markdown review artifact."""

    lines = [
        "# Wrapper Transcript",
        "",
        f"- transcript_id: `{transcript.transcript_id}`",
        f"- channel: `{transcript.channel}`",
        f"- entry_count: {len(transcript.entries)}",
        "",
    ]
    for index, entry in enumerate(transcript.entries, start=1):
        lines.extend(
            [
                f"## {index}. {entry.label}",
                "",
                f"- action: `{entry.action or ''}`",
                f"- category: `{entry.category or ''}`",
                f"- routed: {str(entry.routed).lower()}",
                f"- blocked: {str(entry.blocked).lower()}",
                f"- ok: {str(entry.ok).lower()}",
                f"- error_type: `{entry.error_type or ''}`",
                f"- rendered_text: {entry.rendered_text}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def run_payloads_with_transcript(
    wrapper: LocalBridgeWrapper,
    payloads: list[dict[str, Any]],
    *,
    channel: str = "openclaw",
) -> WrapperTranscript:
    """Run raw payloads through a wrapper and capture review entries."""

    transcript = WrapperTranscript(
        channel=channel,
        metadata={"source": "run_payloads_with_transcript"},
    )
    for index, payload in enumerate(payloads, start=1):
        bridge_request_id = f"transcript-{index:04d}"
        preflight = preflight_openclaw_payload(
            payload,
            bridge_request_id=bridge_request_id,
        )
        result = wrapper.handle_payload(
            payload,
            bridge_request_id=bridge_request_id,
        )
        rendered_text = render_wrapper_result_as_text(result, channel=channel)
        entry = create_wrapper_transcript_entry(
            label=_label_for_payload(payload, index),
            channel=channel,
            payload=payload,
            preflight=preflight,
            route_result=result,
            rendered_text=rendered_text,
            metadata={"sequence": index},
        )
        transcript.add_entry(entry)
    return transcript


def _preflight_payload(
    preflight: Optional[PermissionPreflightResult],
) -> Optional[dict[str, Any]]:
    if preflight is None:
        return None
    return permission_preflight_result_to_payload(preflight)


def _route_payload(
    route_result: Optional[WrapperRouteResult],
) -> Optional[dict[str, Any]]:
    if route_result is None:
        return None
    return render_wrapper_result_payload(route_result)


def _notification_payload(
    route_payload: Optional[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not isinstance(route_payload, dict):
        return None
    metadata = route_payload.get("metadata")
    if not isinstance(metadata, dict):
        return None
    notification = metadata.get("notification")
    if isinstance(notification, dict):
        return sanitize_diagnostic_metadata(notification)
    return None


def _label_for_payload(payload: dict[str, Any], index: int) -> str:
    content = payload.get("content")
    if not isinstance(content, str) or not content:
        content = payload.get("text")
    if isinstance(content, str) and content:
        return content[:80]
    return f"payload-{index:04d}"


def _from_route(route_result: Optional[WrapperRouteResult], field: str) -> object:
    if route_result is None:
        return None
    return getattr(route_result, field, None)


def _from_mapping(mapping: Optional[dict[str, Any]], field: str) -> object:
    if not isinstance(mapping, dict):
        return None
    return mapping.get(field)


def _first_string(*values: object) -> Optional[str]:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None
