"""Payload normalization helpers for the placeholder OpenClaw adapter."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from projectops.adapters.openclaw.models import OpenClawMessage, OpenClawResponse
from projectops.json_io import CONTRACT_VERSION, to_jsonable


class OpenClawPayloadNormalizationError(ValueError):
    """Raised when an OpenClaw-like payload cannot be normalized."""


FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "channel_id": ("channel_id", "channelId", "channel"),
    "user_id": ("user_id", "userId", "sender_id", "author_id"),
    "message_id": ("message_id", "messageId", "id"),
    "text": ("text", "content", "body", "message"),
    "timestamp": ("timestamp", "created_at", "createdAt", "ts"),
    "thread_id": ("thread_id", "threadId", "thread"),
    "reply_to_message_id": (
        "reply_to_message_id",
        "replyToMessageId",
        "reply_to",
        "in_reply_to",
    ),
}

REQUIRED_FIELDS = ("channel_id", "user_id", "message_id", "text", "timestamp")


def normalize_openclaw_message_payload(payload: Mapping[str, Any]) -> OpenClawMessage:
    """Convert a generic OpenClaw-like mapping into an OpenClawMessage."""

    if not isinstance(payload, Mapping):
        raise OpenClawPayloadNormalizationError("Payload must be a mapping.")

    normalized = {
        field: _required_string(payload, field)
        for field in REQUIRED_FIELDS
    }
    optional = {
        "thread_id": _optional_string(payload, "thread_id"),
        "reply_to_message_id": _optional_string(payload, "reply_to_message_id"),
    }
    metadata = _metadata(payload)

    return OpenClawMessage(
        **normalized,
        **optional,
        metadata=metadata,
    )


def openclaw_response_to_payload(response: OpenClawResponse) -> dict[str, Any]:
    """Convert an OpenClawResponse to a JSON-safe payload dictionary."""

    payload = to_jsonable(response)
    if not isinstance(payload, dict):
        raise TypeError("OpenClawResponse did not serialize to a dictionary.")
    return payload


def normalization_error_payload(
    error: OpenClawPayloadNormalizationError,
    payload: object,
) -> dict[str, Any]:
    """Build a JSON-safe error payload for normalization failures."""

    channel_id = _best_effort_string(payload, ("channel_id", "channelId", "channel"))
    thread_id = _best_effort_string(payload, ("thread_id", "threadId", "thread"))
    reply_to_message_id = _best_effort_string(
        payload,
        ("message_id", "messageId", "id"),
    )
    request_id = reply_to_message_id or ""
    return {
        "contract_version": CONTRACT_VERSION,
        "channel_id": channel_id or "unknown",
        "thread_id": thread_id,
        "reply_to_message_id": reply_to_message_id,
        "text": str(error),
        "event_type": "turn_error",
        "request_id": request_id,
        "requires_confirmation": False,
        "ok": False,
        "error_type": "OpenClawPayloadNormalizationError",
        "metadata": {
            "source": "normalization",
        },
    }


def _required_string(payload: Mapping[str, Any], canonical_field: str) -> str:
    value = _first_alias_value(payload, canonical_field)
    if value is None:
        raise OpenClawPayloadNormalizationError(
            f"Missing required field: {canonical_field}."
        )
    if not isinstance(value, str):
        raise OpenClawPayloadNormalizationError(
            f"Required field {canonical_field} must be a string."
        )
    stripped = value.strip()
    if not stripped:
        raise OpenClawPayloadNormalizationError(
            f"Required field {canonical_field} must not be empty."
        )
    return stripped


def _optional_string(
    payload: Mapping[str, Any],
    canonical_field: str,
) -> Optional[str]:
    value = _first_alias_value(payload, canonical_field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise OpenClawPayloadNormalizationError(
            f"Optional field {canonical_field} must be a string."
        )
    stripped = value.strip()
    return stripped or None


def _metadata(payload: Mapping[str, Any]) -> dict[str, Any]:
    metadata = payload.get("metadata", {})
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise OpenClawPayloadNormalizationError("metadata must be a dictionary.")
    return dict(metadata)


def _first_alias_value(payload: Mapping[str, Any], canonical_field: str) -> Any:
    for alias in FIELD_ALIASES[canonical_field]:
        if alias in payload:
            return payload[alias]
    return None


def _best_effort_string(payload: object, aliases: tuple[str, ...]) -> Optional[str]:
    if not isinstance(payload, Mapping):
        return None
    for alias in aliases:
        value = payload.get(alias)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
