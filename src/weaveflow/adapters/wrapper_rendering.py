"""Render local wrapper route results and notifications for channel surfaces."""

from __future__ import annotations

from typing import Any, Optional

from weaveflow.adapters.channel_rendering import (
    collapse_multiline,
    get_channel_render_policy,
    redact_absolute_paths,
    truncate_text,
)
from weaveflow.adapters.local_wrapper import WrapperRouteResult
from weaveflow.adapters.wrapper_notifications import (
    WrapperNotification,
    wrapper_notification_to_payload,
    wrapper_notification_to_text,
)
from weaveflow.json_io import to_jsonable


def render_wrapper_result_as_text(
    result: WrapperRouteResult,
    channel: str = "openclaw",
) -> str:
    """Render a wrapper route result as concise plain text."""

    policy = get_channel_render_policy(channel)
    notification = _notification_from_result(result)
    if notification is not None:
        rendered = render_wrapper_notification_for_channel(
            notification,
            channel=policy.channel,
        )
        if result.error_type and result.error_type not in rendered:
            rendered = f"{result.error_type}: {rendered}"
        return _apply_wrapper_channel_policy(rendered, policy)

    if (
        result.requires_explicit_confirmation
        and not result.routed
        and not result.blocked
    ):
        text = _explicit_confirmation_required_text(result)
        return _apply_wrapper_channel_policy(text, policy)

    if result.blocked and result.category == "future_high_risk":
        action = result.action or "requested action"
        text = (
            f"Blocked: {action} is future high-risk and is not supported."
        )
        return _apply_wrapper_channel_policy(text, policy)

    if result.error_type:
        text = f"Error {result.error_type}: {_safe_result_message(result)}"
        return _apply_wrapper_channel_policy(text, policy)

    if result.routed and result.bridge_response is not None:
        text = _routed_result_text(result, policy.confirmation_hint)
        return _apply_wrapper_channel_policy(text, policy)

    if result.blocked:
        action = result.action or "request"
        text = f"Blocked: {action}. {_safe_result_message(result)}"
        return _apply_wrapper_channel_policy(text, policy)

    text = _safe_result_message(result)
    if result.action and result.action not in text:
        text = f"{result.action}: {text}"
    return _apply_wrapper_channel_policy(text, policy)


def render_wrapper_notification_for_channel(
    notification: WrapperNotification,
    channel: str = "openclaw",
) -> str:
    """Render a wrapper notification for a supported channel."""

    policy = get_channel_render_policy(channel)
    style = "log" if policy.style == "log" else "chat"
    text = wrapper_notification_to_text(notification, style=style)
    if style == "chat" and notification.notification_type not in text:
        text = f"{notification.notification_type}: {text}"
    return _apply_wrapper_channel_policy(text, policy)


def render_wrapper_result_summary(result: WrapperRouteResult) -> str:
    """Return a compact single-line summary for logs."""

    parts = [
        f"routed={str(result.routed).lower()}",
        f"blocked={str(result.blocked).lower()}",
        f"route_reason={result.route_reason}",
    ]
    if result.action:
        parts.append(f"action={result.action}")
    if result.category:
        parts.append(f"category={result.category}")
    if result.error_type:
        parts.append(f"error_type={result.error_type}")
    return collapse_multiline(" ".join(parts))


def render_wrapper_result_payload(result: WrapperRouteResult) -> dict[str, Any]:
    """Return a JSON-safe wrapper result payload."""

    payload = to_jsonable(result)
    if not isinstance(payload, dict):
        raise TypeError("WrapperRouteResult did not serialize to a dictionary.")
    return payload


def _routed_result_text(
    result: WrapperRouteResult,
    confirmation_hint: str,
) -> str:
    action = result.action or "request"
    event_type = _bridge_event_type(result.bridge_response)
    requires_confirmation = _bridge_requires_confirmation(result.bridge_response)

    parts = [f"Routed: {action}.", f"Route reason: {result.route_reason}."]
    if event_type:
        parts.append(f"Bridge returned {event_type}.")
    if requires_confirmation:
        parts.append(confirmation_hint or "Reply yes/no to continue.")
    return " ".join(parts)


def _explicit_confirmation_required_text(result: WrapperRouteResult) -> str:
    action = result.action or "sensitive action"
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    instruction = _string(metadata.get("instruction"))
    phrase = _string(metadata.get("confirmation_phrase"))
    if instruction:
        return f"Explicit confirmation required: {action}. {instruction}"
    if phrase:
        return f"Explicit confirmation required: {action}. Type exactly: {phrase}"
    return f"Explicit confirmation required: {action}. Type the exact phrase shown."


def _notification_from_result(
    result: WrapperRouteResult,
) -> Optional[WrapperNotification]:
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    notification_payload = metadata.get("notification")
    if not isinstance(notification_payload, dict):
        return None
    return WrapperNotification(**notification_payload)


def _safe_result_message(result: WrapperRouteResult) -> str:
    return result.error_message or result.summary or "Wrapper result."


def _bridge_event_type(bridge_response: Optional[dict[str, Any]]) -> Optional[str]:
    payload = _bridge_payload(bridge_response)
    if payload is None:
        return None
    return _string(payload.get("event_type"))


def _bridge_requires_confirmation(bridge_response: Optional[dict[str, Any]]) -> bool:
    payload = _bridge_payload(bridge_response)
    if payload is None:
        return False
    return (
        payload.get("requires_confirmation") is True
        or payload.get("event_type") == "pending_confirmation"
    )


def _bridge_payload(
    bridge_response: Optional[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not isinstance(bridge_response, dict):
        return None
    payload = bridge_response.get("response")
    if isinstance(payload, dict):
        return payload
    return None


def _apply_wrapper_channel_policy(text: str, policy) -> str:
    text = redact_absolute_paths(text)
    if not policy.multiline:
        text = collapse_multiline(text)
    return truncate_text(text, policy.max_length)


def _string(value: object) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    return None
