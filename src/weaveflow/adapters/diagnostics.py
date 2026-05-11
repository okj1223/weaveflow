"""Structured diagnostics for adapter bridge processes."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from typing import Any, Optional, TextIO

from pydantic import BaseModel, Field

from weaveflow.json_io import CONTRACT_VERSION, to_jsonable


DIAGNOSTIC_VERSION = "weaveflow.diagnostics.v1"
ALLOWED_DIAGNOSTIC_LEVELS = {"debug", "info", "warning", "error"}
ABSOLUTE_PATH_PATTERN = re.compile(r"(?<!\w)/(?:tmp|home|mnt/data)(?:/[^\s\"'<>]+)*")


class DiagnosticEvent(BaseModel):
    contract_version: str = CONTRACT_VERSION
    diagnostic_version: str = DIAGNOSTIC_VERSION
    level: str
    event: str
    bridge_request_id: Optional[str] = None
    request_id: Optional[str] = None
    action: Optional[str] = None
    message: str
    timestamp: str
    metadata: dict[str, Any] = Field(default_factory=dict)


def create_diagnostic_event(
    event: str,
    level: str = "info",
    message: str = "",
    bridge_request_id: Optional[str] = None,
    request_id: Optional[str] = None,
    action: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> DiagnosticEvent:
    """Create a JSON-safe diagnostic event."""

    if level not in ALLOWED_DIAGNOSTIC_LEVELS:
        raise ValueError(f"Unsupported diagnostic level: {level}.")

    return DiagnosticEvent(
        level=level,
        event=event,
        bridge_request_id=bridge_request_id,
        request_id=request_id,
        action=action,
        message=message,
        timestamp=_utc_timestamp(),
        metadata=sanitize_diagnostic_metadata(metadata or {}),
    )


def diagnostic_event_to_json_line(event: DiagnosticEvent) -> str:
    """Serialize a diagnostic event to one compact JSON line."""

    return json.dumps(to_jsonable(event), separators=(",", ":"), sort_keys=True)


def sanitize_diagnostic_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Make diagnostic metadata JSON-safe with lightweight path redaction."""

    sanitized = _sanitize_value(metadata)
    if isinstance(sanitized, dict):
        return sanitized
    return {"value": sanitized}


def redact_diagnostic_text(text: str) -> str:
    """Redact obvious absolute local paths from diagnostic text."""

    return ABSOLUTE_PATH_PATTERN.sub("<path>", text)


class DiagnosticWriter:
    """Write structured diagnostic events to stderr or an injected stream."""

    def __init__(self, stream: Optional[TextIO] = None, enabled: bool = True) -> None:
        if stream is None or stream is sys.stdout:
            stream = sys.stderr
        self.stream = stream
        self.enabled = enabled

    def write_event(self, event: DiagnosticEvent) -> None:
        if not self.enabled:
            return

        try:
            self.stream.write(diagnostic_event_to_json_line(event) + "\n")
            flush = getattr(self.stream, "flush", None)
            if callable(flush):
                flush()
        except Exception:
            return


def _sanitize_value(value: Any) -> Any:
    jsonable = to_jsonable(value)

    if isinstance(jsonable, str):
        return redact_diagnostic_text(jsonable)
    if isinstance(jsonable, dict):
        return {str(key): _sanitize_value(item) for key, item in jsonable.items()}
    if isinstance(jsonable, list):
        return [_sanitize_value(item) for item in jsonable]
    if isinstance(jsonable, tuple):
        return [_sanitize_value(item) for item in jsonable]
    if jsonable is None or isinstance(jsonable, (bool, int, float)):
        return jsonable

    try:
        json.dumps(jsonable)
    except TypeError:
        return redact_diagnostic_text(str(jsonable))
    return jsonable


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00",
        "Z",
    )
