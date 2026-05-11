"""Permission preflight helpers for future adapter wrappers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from pydantic import BaseModel, Field

from weaveflow.adapters.base import AdapterRequest
from weaveflow.adapters.intent_mapper import (
    IntentMappingResult,
    map_text_to_adapter_request,
    normalize_text,
)
from weaveflow.adapters.openclaw.normalization import (
    OpenClawPayloadNormalizationError,
    normalize_openclaw_message_payload,
)
from weaveflow.adapters.permissions import (
    PermissionDecision,
    evaluate_action_permission,
)
from weaveflow.json_io import CONTRACT_VERSION, to_jsonable


HIGH_RISK_TEXT_ACTIONS = {
    "auto run codex": "auto_run_codex",
    "autorun codex": "auto_run_codex",
    "run codex automatically": "auto_run_codex",
    "apply memory diff": "apply_memory_diff",
    "repair workspace": "repair_workspace",
    "delete artifact": "delete_artifact",
    "edit task history": "edit_task_history",
    "deploy": "deploy",
    "call external api": "external_api_action",
    "external api action": "external_api_action",
}


class PermissionPreflightResult(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    source: str
    action: Optional[str] = None
    category: Optional[str] = None
    allowed: bool
    blocked: bool
    read_only: bool
    mutating: bool
    requires_confirmation: bool
    requires_explicit_confirmation: bool
    should_route: bool
    should_ask_confirmation: bool
    should_ask_explicit_confirmation: bool
    reason: str
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


def preflight_text_command(
    text: str,
    *,
    allow_mutation: bool = False,
    explicit_confirmation: bool = False,
    request_id: Optional[str] = None,
    bridge_request_id: Optional[str] = None,
) -> PermissionPreflightResult:
    """Evaluate permission preflight for a deterministic text command."""

    high_risk_action = _high_risk_action(text)
    if high_risk_action is not None:
        decision = evaluate_action_permission(
            high_risk_action,
            allow_mutation=allow_mutation,
            explicit_confirmation=explicit_confirmation,
        )
        return _result_from_decision(
            source="text",
            decision=decision,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
            metadata={
                "normalized_text": normalize_text(text),
                "preflight_only": True,
            },
        )

    mapping = map_text_to_adapter_request(
        text,
        allow_mutation=allow_mutation,
        request_id=request_id,
    )
    if not mapping.ok or mapping.action is None:
        return _mapping_error_result(
            source="text",
            mapping=mapping,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
        )

    decision = evaluate_action_permission(
        mapping.action,
        allow_mutation=allow_mutation,
        explicit_confirmation=explicit_confirmation,
    )
    return _result_from_decision(
        source="text",
        decision=decision,
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        metadata={
            "normalized_text": mapping.normalized_text,
            "params": mapping.params,
        },
    )


def preflight_openclaw_payload(
    payload: Mapping[str, Any],
    *,
    allow_mutation: bool = False,
    explicit_confirmation: bool = False,
    bridge_request_id: Optional[str] = None,
) -> PermissionPreflightResult:
    """Evaluate permission preflight for a raw OpenClaw-like payload."""

    try:
        message = normalize_openclaw_message_payload(payload)
    except OpenClawPayloadNormalizationError as exc:
        return PermissionPreflightResult(
            ok=False,
            source="raw_payload",
            action=None,
            category=None,
            allowed=False,
            blocked=True,
            read_only=False,
            mutating=False,
            requires_confirmation=False,
            requires_explicit_confirmation=False,
            should_route=False,
            should_ask_confirmation=False,
            should_ask_explicit_confirmation=False,
            reason=str(exc),
            request_id=None,
            bridge_request_id=bridge_request_id,
            error_type="OpenClawPayloadNormalizationError",
            error_message=str(exc),
            metadata={"source": "normalization"},
        )

    result = preflight_text_command(
        message.text,
        allow_mutation=allow_mutation,
        explicit_confirmation=explicit_confirmation,
        request_id=message.message_id,
        bridge_request_id=bridge_request_id,
    )
    metadata = dict(result.metadata)
    metadata.update(
        {
            "channel_id": message.channel_id,
            "user_id": message.user_id,
            "thread_id": message.thread_id,
        }
    )
    return result.model_copy(update={"source": "raw_payload", "metadata": metadata})


def preflight_adapter_request(
    request: AdapterRequest,
    *,
    explicit_confirmation: bool = False,
    bridge_request_id: Optional[str] = None,
) -> PermissionPreflightResult:
    """Evaluate permission preflight for an already structured adapter request."""

    decision = evaluate_action_permission(
        request.action,
        allow_mutation=request.allow_mutation,
        explicit_confirmation=explicit_confirmation,
    )
    return _result_from_decision(
        source="adapter_request",
        decision=decision,
        request_id=request.request_id,
        bridge_request_id=bridge_request_id,
        metadata={"params": request.params},
    )


def permission_preflight_result_to_payload(
    result: PermissionPreflightResult,
) -> dict[str, Any]:
    """Return a JSON-safe dictionary for a preflight result."""

    payload = to_jsonable(result)
    if not isinstance(payload, dict):
        raise TypeError("PermissionPreflightResult did not serialize to a dictionary.")
    return payload


def _result_from_decision(
    *,
    source: str,
    decision: PermissionDecision,
    request_id: Optional[str],
    bridge_request_id: Optional[str],
    metadata: Optional[dict[str, Any]] = None,
) -> PermissionPreflightResult:
    should_ask_explicit = (
        not decision.allowed
        and not decision.blocked
        and decision.requires_explicit_confirmation
    )
    should_ask_confirmation = (
        not decision.allowed
        and not decision.blocked
        and decision.requires_confirmation
        and not should_ask_explicit
    )
    should_route = decision.allowed and not decision.blocked

    return PermissionPreflightResult(
        ok=True,
        source=source,
        action=decision.action,
        category=decision.category,
        allowed=decision.allowed,
        blocked=decision.blocked,
        read_only=decision.read_only,
        mutating=decision.mutating,
        requires_confirmation=decision.requires_confirmation,
        requires_explicit_confirmation=decision.requires_explicit_confirmation,
        should_route=should_route,
        should_ask_confirmation=should_ask_confirmation,
        should_ask_explicit_confirmation=should_ask_explicit,
        reason=decision.reason,
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        error_type=None,
        error_message=None,
        metadata=to_jsonable(metadata or {}),
    )


def _mapping_error_result(
    *,
    source: str,
    mapping: IntentMappingResult,
    request_id: Optional[str],
    bridge_request_id: Optional[str],
) -> PermissionPreflightResult:
    return PermissionPreflightResult(
        ok=False,
        source=source,
        action=None,
        category=None,
        allowed=False,
        blocked=True,
        read_only=False,
        mutating=False,
        requires_confirmation=False,
        requires_explicit_confirmation=False,
        should_route=False,
        should_ask_confirmation=False,
        should_ask_explicit_confirmation=False,
        reason=mapping.error_message or "Could not map command.",
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        error_type=mapping.error_type or "UnknownIntent",
        error_message=mapping.error_message,
        metadata={
            "normalized_text": mapping.normalized_text,
        },
    )


def _high_risk_action(text: str) -> Optional[str]:
    return HIGH_RISK_TEXT_ACTIONS.get(normalize_text(text))
