"""Explicit confirmation helpers for sensitive adapter actions."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from weaveflow.adapters.permission_preflight import PermissionPreflightResult
from weaveflow.json_io import CONTRACT_VERSION, to_jsonable


EXPLICIT_CONFIRMATION_WARNING = (
    "This action changes task verification/reporting state and requires "
    "explicit confirmation."
)


class ExplicitConfirmationPrompt(BaseModel):
    contract_version: str = CONTRACT_VERSION
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    action: str
    category: str
    reason: str
    confirmation_phrase: str
    instruction: str
    warning: str
    params_summary: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExplicitConfirmationCheck(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    matched: bool
    action: Optional[str] = None
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    summary: str


def build_explicit_confirmation_phrase(
    action: str,
    request_id: Optional[str] = None,
) -> str:
    """Build the exact phrase required for sensitive action confirmation."""

    normalized_action = action.lower()
    if request_id is None:
        return f"confirm {normalized_action}"
    return f"confirm {normalized_action} {request_id}"


def create_explicit_confirmation_prompt(
    preflight: PermissionPreflightResult,
) -> ExplicitConfirmationPrompt:
    """Create a user-facing prompt for a sensitive action preflight."""

    if not is_explicit_confirmation_required(preflight):
        raise ValueError("Explicit confirmation is not required for this preflight.")
    if not preflight.action:
        raise ValueError("Explicit confirmation requires a known action.")
    if not preflight.category:
        raise ValueError("Explicit confirmation requires an action category.")

    phrase = build_explicit_confirmation_phrase(
        preflight.action,
        preflight.request_id,
    )
    params_summary = {
        "action": preflight.action,
        "category": preflight.category,
        "request_id": preflight.request_id,
        "bridge_request_id": preflight.bridge_request_id,
    }
    return ExplicitConfirmationPrompt(
        request_id=preflight.request_id,
        bridge_request_id=preflight.bridge_request_id,
        action=preflight.action,
        category=preflight.category,
        reason=preflight.reason,
        confirmation_phrase=phrase,
        instruction=f"Type exactly: {phrase}",
        warning=EXPLICIT_CONFIRMATION_WARNING,
        params_summary=to_jsonable(params_summary),
        metadata={"source": preflight.source},
    )


def check_explicit_confirmation(
    text: str,
    prompt: ExplicitConfirmationPrompt,
) -> ExplicitConfirmationCheck:
    """Check whether text matches a prompt's required confirmation phrase."""

    candidate = text.strip()
    if not candidate:
        return ExplicitConfirmationCheck(
            ok=False,
            matched=False,
            action=prompt.action,
            request_id=prompt.request_id,
            bridge_request_id=prompt.bridge_request_id,
            error_type="EmptyExplicitConfirmation",
            error_message="Explicit confirmation text is empty.",
            summary="Explicit confirmation did not match.",
        )

    matched = candidate.casefold() == prompt.confirmation_phrase.casefold()
    if matched:
        return ExplicitConfirmationCheck(
            ok=True,
            matched=True,
            action=prompt.action,
            request_id=prompt.request_id,
            bridge_request_id=prompt.bridge_request_id,
            summary="Explicit confirmation matched.",
        )

    return ExplicitConfirmationCheck(
        ok=False,
        matched=False,
        action=prompt.action,
        request_id=prompt.request_id,
        bridge_request_id=prompt.bridge_request_id,
        error_type="ExplicitConfirmationMismatch",
        error_message="Explicit confirmation text did not match the required phrase.",
        summary="Explicit confirmation did not match.",
    )


def is_explicit_confirmation_required(
    preflight: PermissionPreflightResult,
) -> bool:
    """Return whether a preflight requires explicit confirmation."""

    return (
        preflight.requires_explicit_confirmation
        or preflight.should_ask_explicit_confirmation
    )


def summarize_explicit_confirmation_prompt(
    prompt: ExplicitConfirmationPrompt,
) -> str:
    """Return a concise user-facing explicit confirmation prompt."""

    return f"{prompt.warning} {prompt.instruction}"
