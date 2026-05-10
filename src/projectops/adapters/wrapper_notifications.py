"""Wrapper notification models for restart and session-loss events."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.diagnostics import sanitize_diagnostic_metadata
from projectops.adapters.permissions import (
    FUTURE_HIGH_RISK_ACTIONS,
    READ_ONLY_ACTIONS,
    SAFE_MUTATION_ACTIONS,
    SENSITIVE_MUTATION_ACTIONS,
)
from projectops.json_io import CONTRACT_VERSION, to_jsonable


SESSION_LOSS_NOTIFICATION_TYPE = "session_loss"
BRIDGE_RESTARTED_NOTIFICATION_TYPE = "bridge_restarted"
PENDING_CONFIRMATION_CLEARED_NOTIFICATION_TYPE = "pending_confirmation_cleared"
WRAPPER_WARNING_NOTIFICATION_TYPE = "wrapper_warning"
WRAPPER_ERROR_NOTIFICATION_TYPE = "wrapper_error"

SESSION_LOSS_MESSAGE = (
    "The ProjectOps bridge restarted. Pending confirmations were cleared. "
    "Please repeat the command if needed."
)
SESSION_LOSS_SUGGESTED_ACTION = "Repeat the command if you still want to proceed."

ALLOWED_NOTIFICATION_TYPES = {
    SESSION_LOSS_NOTIFICATION_TYPE,
    BRIDGE_RESTARTED_NOTIFICATION_TYPE,
    PENDING_CONFIRMATION_CLEARED_NOTIFICATION_TYPE,
    WRAPPER_WARNING_NOTIFICATION_TYPE,
    WRAPPER_ERROR_NOTIFICATION_TYPE,
}
ALLOWED_NOTIFICATION_LEVELS = {"info", "warning", "error"}


class WrapperNotification(BaseModel):
    contract_version: str = CONTRACT_VERSION
    notification_type: str
    level: str
    message: str
    suggested_action: str
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    session_key: Optional[str] = None
    action: Optional[str] = None
    pending_cleared: bool
    retry_safe: bool
    requires_user_repetition: bool
    metadata: dict[str, Any] = Field(default_factory=dict)


def create_session_loss_notification(
    *,
    request_id: Optional[str] = None,
    bridge_request_id: Optional[str] = None,
    session_key: Optional[str] = None,
    action: Optional[str] = None,
    retry_safe: bool = False,
    metadata: Optional[dict[str, Any]] = None,
) -> WrapperNotification:
    """Create a JSON-safe session-loss notification."""

    return _create_notification(
        notification_type=SESSION_LOSS_NOTIFICATION_TYPE,
        level="warning",
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        session_key=session_key,
        action=action,
        retry_safe=retry_safe,
        metadata=metadata,
    )


def create_pending_cleared_notification(
    *,
    request_id: Optional[str] = None,
    bridge_request_id: Optional[str] = None,
    session_key: Optional[str] = None,
    action: Optional[str] = None,
    retry_safe: bool = False,
    metadata: Optional[dict[str, Any]] = None,
) -> WrapperNotification:
    """Create a notification for cleared pending confirmation state."""

    return _create_notification(
        notification_type=PENDING_CONFIRMATION_CLEARED_NOTIFICATION_TYPE,
        level="warning",
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        session_key=session_key,
        action=action,
        retry_safe=retry_safe,
        metadata=metadata,
    )


def wrapper_notification_to_text(
    notification: WrapperNotification,
    style: str = "chat",
) -> str:
    """Render a wrapper notification as concise user-facing or log text."""

    normalized_style = style.strip().lower()
    if normalized_style == "chat":
        parts = [notification.message, notification.suggested_action]
        correlation = _correlation_text(notification)
        if correlation:
            parts.append(correlation)
        return " ".join(part for part in parts if part)

    if normalized_style == "log":
        parts = [
            f"type={notification.notification_type}",
            f"level={notification.level}",
            f"pending_cleared={str(notification.pending_cleared).lower()}",
            f"retry_safe={str(notification.retry_safe).lower()}",
        ]
        if notification.request_id:
            parts.append(f"request_id={notification.request_id}")
        if notification.bridge_request_id:
            parts.append(f"bridge_request_id={notification.bridge_request_id}")
        if notification.session_key:
            parts.append(f"session_key={notification.session_key}")
        if notification.action:
            parts.append(f"action={notification.action}")
        parts.append(f"message={notification.message}")
        return " ".join(parts)

    raise ValueError(f"Unsupported wrapper notification text style: {style}.")


def wrapper_notification_to_payload(
    notification: WrapperNotification,
) -> dict[str, Any]:
    """Return a JSON-safe payload for a wrapper notification."""

    payload = to_jsonable(notification)
    if not isinstance(payload, dict):
        raise TypeError("WrapperNotification did not serialize to a dictionary.")
    payload["metadata"] = sanitize_diagnostic_metadata(
        payload.get("metadata", {})
        if isinstance(payload.get("metadata"), dict)
        else {"value": payload.get("metadata")}
    )
    return payload


def is_retry_safe_after_session_loss(action: Optional[str]) -> bool:
    """Return whether an action may be retried/read after session loss."""

    if action is None:
        return False
    if action in READ_ONLY_ACTIONS:
        return True
    if action in (
        SAFE_MUTATION_ACTIONS
        | SENSITIVE_MUTATION_ACTIONS
        | FUTURE_HIGH_RISK_ACTIONS
    ):
        return False
    return False


def _create_notification(
    *,
    notification_type: str,
    level: str,
    request_id: Optional[str],
    bridge_request_id: Optional[str],
    session_key: Optional[str],
    action: Optional[str],
    retry_safe: bool,
    metadata: Optional[dict[str, Any]],
) -> WrapperNotification:
    if notification_type not in ALLOWED_NOTIFICATION_TYPES:
        raise ValueError(f"Unsupported wrapper notification type: {notification_type}.")
    if level not in ALLOWED_NOTIFICATION_LEVELS:
        raise ValueError(f"Unsupported wrapper notification level: {level}.")

    return WrapperNotification(
        notification_type=notification_type,
        level=level,
        message=SESSION_LOSS_MESSAGE,
        suggested_action=SESSION_LOSS_SUGGESTED_ACTION,
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        session_key=session_key,
        action=action,
        pending_cleared=True,
        retry_safe=retry_safe,
        requires_user_repetition=True,
        metadata=sanitize_diagnostic_metadata(metadata or {}),
    )


def _correlation_text(notification: WrapperNotification) -> str:
    identifiers = []
    if notification.request_id:
        identifiers.append(f"request_id={notification.request_id}")
    if notification.bridge_request_id:
        identifiers.append(f"bridge_request_id={notification.bridge_request_id}")
    if not identifiers:
        return ""
    return "(" + ", ".join(identifiers) + ")"
