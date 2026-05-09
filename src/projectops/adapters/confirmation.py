"""Confirmation helpers for mutating adapter intents."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.base import AdapterRequest
from projectops.adapters.intent_mapper import map_text_to_adapter_request


CONFIRMATION_WORDS = {"yes", "y", "confirm", "confirmed", "approve", "approved", "ok"}
REJECTION_WORDS = {"no", "n", "cancel", "reject", "rejected", "stop"}


class ConfirmationState(BaseModel):
    required: bool
    confirmed: bool
    original_text: str
    action: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    request_id: Optional[str] = None
    message: str
    request: Optional[AdapterRequest] = None


def prepare_confirmation(
    text: str,
    request_id: Optional[str] = None,
) -> ConfirmationState:
    mapping = map_text_to_adapter_request(
        text,
        allow_mutation=False,
        request_id=request_id,
    )

    if not mapping.ok:
        detail = mapping.error_message or "Could not map command."
        return ConfirmationState(
            required=False,
            confirmed=False,
            original_text=mapping.original_text,
            action=mapping.action,
            params=mapping.params,
            request_id=request_id,
            message=f"{mapping.error_type}: {detail}",
            request=None,
        )

    if not mapping.requires_confirmation:
        return ConfirmationState(
            required=False,
            confirmed=True,
            original_text=mapping.original_text,
            action=mapping.action,
            params=mapping.params,
            request_id=request_id,
            message="No confirmation required.",
            request=mapping.request,
        )

    return ConfirmationState(
        required=True,
        confirmed=False,
        original_text=mapping.original_text,
        action=mapping.action,
        params=mapping.params,
        request_id=request_id,
        message=f"Confirm mutating action: {mapping.action}",
        request=mapping.request,
    )


def confirm_request(state: ConfirmationState) -> ConfirmationState:
    if not state.required:
        if state.confirmed:
            return state
        return ConfirmationState(
            required=state.required,
            confirmed=state.confirmed,
            original_text=state.original_text,
            action=state.action,
            params=state.params,
            request_id=state.request_id,
            message=state.message,
            request=state.request,
        )

    if state.request is None:
        return ConfirmationState(
            required=True,
            confirmed=False,
            original_text=state.original_text,
            action=state.action,
            params=state.params,
            request_id=state.request_id,
            message="Confirmation cannot proceed because no request is available.",
            request=None,
        )

    confirmed_request = AdapterRequest(
        action=state.request.action,
        params=dict(state.request.params),
        allow_mutation=True,
        request_id=state.request.request_id,
    )
    return ConfirmationState(
        required=False,
        confirmed=True,
        original_text=state.original_text,
        action=state.action,
        params=dict(state.params),
        request_id=state.request_id,
        message=f"Confirmed mutating action: {state.action}",
        request=confirmed_request,
    )


def reject_request(state: ConfirmationState) -> ConfirmationState:
    return ConfirmationState(
        required=False,
        confirmed=False,
        original_text=state.original_text,
        action=state.action,
        params=dict(state.params),
        request_id=state.request_id,
        message=f"Rejected adapter action: {state.action}",
        request=None,
    )


def is_confirmation_response(text: str) -> Optional[bool]:
    normalized = text.strip().lower()
    if normalized in CONFIRMATION_WORDS:
        return True
    if normalized in REJECTION_WORDS:
        return False
    return None
