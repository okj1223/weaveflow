"""Local wrapper smoke flow for stdio bridge routing decisions."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.confirmation import is_confirmation_response
from projectops.adapters.explicit_confirmation import (
    ExplicitConfirmationPrompt,
    check_explicit_confirmation,
    create_explicit_confirmation_prompt,
)
from projectops.adapters.openclaw.normalization import (
    OpenClawPayloadNormalizationError,
    normalize_openclaw_message_payload,
)
from projectops.adapters.permission_preflight import (
    PermissionPreflightResult,
    permission_preflight_result_to_payload,
    preflight_openclaw_payload,
)
from projectops.adapters.permissions import FUTURE_HIGH_RISK, UNKNOWN
from projectops.adapters.stdio_client import StdioBridgeClient
from projectops.adapters.stdio_health import (
    BridgeHealthResult,
    validate_stdout_response_line,
)
from projectops.json_io import CONTRACT_VERSION, to_jsonable
from projectops.models import utc_now_iso


SESSION_LOSS_MESSAGE = (
    "The ProjectOps bridge restarted. Pending confirmations were cleared. "
    "Please repeat the command if needed."
)


class WrapperRouteResult(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    bridge_request_id: Optional[str] = None
    routed: bool
    blocked: bool
    route_reason: str
    action: Optional[str] = None
    category: Optional[str] = None
    requires_confirmation: bool
    requires_explicit_confirmation: bool
    preflight: Optional[dict[str, Any]] = None
    bridge_response: Optional[dict[str, Any]] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    summary: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class PendingExplicitConfirmation(BaseModel):
    contract_version: str = CONTRACT_VERSION
    bridge_request_id: str
    request_id: Optional[str] = None
    action: str
    original_payload: dict[str, Any]
    prompt: dict[str, Any]
    created_at: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class LocalBridgeWrapper:
    """Small local wrapper that preflights payloads before bridge routing."""

    def __init__(
        self,
        root: Path,
        *,
        diagnostics: bool = False,
        timeout: float = 5.0,
    ) -> None:
        self.root = Path(root)
        self.diagnostics = diagnostics
        self.timeout = timeout
        self._client: Optional[StdioBridgeClient] = None
        self._health: Optional[BridgeHealthResult] = None
        self._counter = 0
        self._pending_explicit_confirmations: dict[str, PendingExplicitConfirmation] = {}

    def start(self) -> BridgeHealthResult:
        """Start the bridge subprocess and run a ping health check."""

        if self._client is None:
            self._client = StdioBridgeClient(self._bridge_command())
        self._client.start()

        bridge_request_id = "wrapper-health-ping"
        try:
            response = self._client.send(_bridge_request(bridge_request_id, "ping"))
        except Exception as exc:
            self._health = BridgeHealthResult(
                ok=False,
                bridge_request_id=bridge_request_id,
                pong=False,
                stdout_valid=False,
                stderr_valid=True,
                error_type="BridgeHealthCheckFailed",
                error_message=str(exc),
                summary=f"Bridge health check failed: {exc}",
            )
            return self._health

        validation = validate_stdout_response_line(json.dumps(response))
        pong = _response_has_pong(response)
        ok = validation.ok and pong
        self._health = BridgeHealthResult(
            ok=ok,
            bridge_request_id=bridge_request_id,
            pong=pong,
            stdout_valid=validation.ok,
            stderr_valid=True,
            error_type=None if ok else validation.error_type or "MissingPong",
            error_message=None
            if ok
            else validation.error_message
            or "Bridge ping response did not contain pong=true.",
            summary="Bridge health check passed."
            if ok
            else "Bridge health check failed.",
            response=to_jsonable(response),
            diagnostics=[],
        )
        return self._health

    def is_running(self) -> bool:
        return self._client is not None and self._client.is_running()

    def session_loss_message(self) -> str:
        """Return the recommended user-facing restart/session-loss message."""

        return SESSION_LOSS_MESSAGE

    def prepare_explicit_confirmation(
        self,
        payload: dict[str, Any],
        bridge_request_id: Optional[str] = None,
    ) -> ExplicitConfirmationPrompt:
        """Build an explicit confirmation prompt without routing a payload."""

        preflight = preflight_openclaw_payload(
            payload,
            allow_mutation=True,
            explicit_confirmation=False,
            bridge_request_id=bridge_request_id,
        )
        return create_explicit_confirmation_prompt(preflight)

    def set_pending_explicit_confirmation(
        self,
        key: str,
        pending: PendingExplicitConfirmation,
    ) -> None:
        if not key:
            raise ValueError("Pending explicit confirmation key must be non-empty.")
        self._pending_explicit_confirmations[key] = pending

    def get_pending_explicit_confirmation(
        self,
        key: str,
    ) -> Optional[PendingExplicitConfirmation]:
        if not key:
            return None
        return self._pending_explicit_confirmations.get(key)

    def clear_pending_explicit_confirmation(self, key: str) -> None:
        if key:
            self._pending_explicit_confirmations.pop(key, None)

    def list_pending_explicit_confirmations(self) -> list[PendingExplicitConfirmation]:
        return list(self._pending_explicit_confirmations.values())

    def handle_payload(
        self,
        payload: dict[str, Any],
        *,
        bridge_request_id: Optional[str] = None,
        explicit_confirmation: bool = False,
    ) -> WrapperRouteResult:
        """Preflight and conditionally route one raw payload to the bridge."""

        bridge_request_id = bridge_request_id or self._next_bridge_request_id()
        if not self.is_running():
            return _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="bridge_not_running",
                summary="Bridge is not running.",
                error_type="BridgeNotRunning",
                error_message="Bridge is not running.",
            )
        if self._health is None or not self._health.ok:
            return _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="bridge_not_healthy",
                summary="Bridge health check has not passed.",
                error_type="BridgeNotHealthy",
                error_message="Bridge health check has not passed.",
            )

        try:
            message = normalize_openclaw_message_payload(payload)
        except OpenClawPayloadNormalizationError as exc:
            return _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="invalid_payload",
                summary=f"Payload blocked: {exc}",
                error_type="OpenClawPayloadNormalizationError",
                error_message=str(exc),
                metadata={"source": "normalization"},
            )

        if is_confirmation_response(message.text) is not None:
            return self._route_payload(
                payload,
                bridge_request_id=bridge_request_id,
                route_reason="confirmation_response",
                summary_action=None,
                summary_category=None,
                preflight=None,
            )

        preflight = preflight_openclaw_payload(
            payload,
            allow_mutation=explicit_confirmation,
            explicit_confirmation=explicit_confirmation,
            bridge_request_id=bridge_request_id,
        )
        if not preflight.ok:
            return _blocked_preflight_result(
                preflight,
                bridge_request_id=bridge_request_id,
                route_reason="preflight_error",
            )
        if preflight.blocked or preflight.category in {FUTURE_HIGH_RISK, UNKNOWN}:
            return _blocked_preflight_result(
                preflight,
                bridge_request_id=bridge_request_id,
                route_reason="blocked_by_preflight",
            )
        if (
            preflight.requires_explicit_confirmation
            and preflight.should_ask_explicit_confirmation
        ):
            return self._store_explicit_confirmation(
                payload,
                preflight=preflight,
                bridge_request_id=bridge_request_id,
            )
        if preflight.should_ask_confirmation:
            return self._route_payload(
                payload,
                bridge_request_id=bridge_request_id,
                route_reason="route_to_establish_pending_confirmation",
                summary_action=preflight.action,
                summary_category=preflight.category,
                preflight=preflight,
            )
        if preflight.should_route:
            return self._route_payload(
                payload,
                bridge_request_id=bridge_request_id,
                route_reason="route_allowed",
                summary_action=preflight.action,
                summary_category=preflight.category,
                preflight=preflight,
            )

        return _result_from_preflight(
            preflight,
            bridge_request_id=bridge_request_id,
            ok=False,
            routed=False,
            blocked=True,
            route_reason="no_route_decision",
            summary="Payload blocked: no route decision was available.",
        )

    def handle_explicit_confirmation(
        self,
        text: str,
        *,
        bridge_request_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> WrapperRouteResult:
        """Check an exact phrase and route the stored sensitive payload."""

        result_bridge_request_id = bridge_request_id or request_id
        if not self.is_running():
            return _result(
                ok=False,
                bridge_request_id=result_bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="bridge_not_running",
                summary="Bridge is not running.",
                error_type="BridgeNotRunning",
                error_message="Bridge is not running.",
            )
        if self._health is None or not self._health.ok:
            return _result(
                ok=False,
                bridge_request_id=result_bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="bridge_not_healthy",
                summary="Bridge health check has not passed.",
                error_type="BridgeNotHealthy",
                error_message="Bridge health check has not passed.",
            )

        pending_key, pending = self._find_pending_explicit_confirmation(
            bridge_request_id=bridge_request_id,
            request_id=request_id,
        )
        if pending is None or pending_key is None:
            return _result(
                ok=False,
                bridge_request_id=result_bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="pending_explicit_confirmation_not_found",
                summary="Pending explicit confirmation was not found.",
                error_type="PendingExplicitConfirmationNotFound",
                error_message="Pending explicit confirmation was not found.",
            )

        prompt = ExplicitConfirmationPrompt(**pending.prompt)
        check = check_explicit_confirmation(text, prompt)
        if not check.ok or not check.matched:
            return _result(
                ok=False,
                bridge_request_id=pending.bridge_request_id,
                routed=False,
                blocked=False,
                route_reason="explicit_confirmation_mismatch",
                action=pending.action,
                category=prompt.category,
                requires_explicit_confirmation=True,
                summary="Explicit confirmation phrase did not match.",
                error_type=check.error_type,
                error_message=check.error_message,
                metadata={
                    "pending_key": pending_key,
                    "explicit_confirmation_matched": False,
                },
            )

        result = self._route_explicitly_confirmed_payload(pending)
        self.clear_pending_explicit_confirmation(pending_key)
        return result

    def shutdown(self) -> Optional[WrapperRouteResult]:
        """Shutdown the bridge subprocess if it is running."""

        if self._client is None:
            self._pending_explicit_confirmations.clear()
            return None
        if not self._client.is_running():
            self._client.close()
            self._client = None
            self._health = None
            self._pending_explicit_confirmations.clear()
            return _result(
                ok=True,
                bridge_request_id=None,
                routed=False,
                blocked=False,
                route_reason="already_closed",
                summary="Bridge already closed.",
            )

        bridge_request_id = self._next_bridge_request_id("shutdown")
        try:
            response = self._client.send(_bridge_request(bridge_request_id, "shutdown"))
            ok = _valid_bridge_response(response) and bool(response.get("ok"))
            result = _result(
                ok=ok,
                bridge_request_id=bridge_request_id,
                routed=True,
                blocked=False,
                route_reason="shutdown",
                summary="Bridge shutdown requested."
                if ok
                else "Bridge shutdown request failed.",
                bridge_response=to_jsonable(response),
                error_type=None if ok else _string(response.get("error_type")),
                error_message=None if ok else _string(response.get("error_message")),
            )
        except Exception as exc:
            result = _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=True,
                blocked=False,
                route_reason="shutdown_failed",
                summary=f"Bridge shutdown failed: {exc}",
                error_type="BridgeShutdownFailed",
                error_message=str(exc),
            )
        finally:
            self._client.close()
            self._client = None
            self._health = None
            self._pending_explicit_confirmations.clear()
        return result

    def __enter__(self) -> "LocalBridgeWrapper":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.shutdown()

    def _bridge_command(self) -> list[str]:
        command = [
            sys.executable,
            "-m",
            "projectops.adapters.stdio_bridge",
            "--root",
            str(self.root),
        ]
        if self.diagnostics:
            command.append("--diagnostics-stderr")
        return command

    def _next_bridge_request_id(self, prefix: str = "wrapper") -> str:
        self._counter += 1
        return f"{prefix}-{self._counter:04d}"

    def _store_explicit_confirmation(
        self,
        payload: dict[str, Any],
        *,
        preflight: PermissionPreflightResult,
        bridge_request_id: str,
    ) -> WrapperRouteResult:
        prompt = create_explicit_confirmation_prompt(preflight)
        prompt_payload = to_jsonable(prompt)
        if not isinstance(prompt_payload, dict):
            prompt_payload = {}

        original_payload = to_jsonable(payload)
        if not isinstance(original_payload, dict):
            original_payload = dict(payload)

        pending_key = _pending_explicit_confirmation_key(
            bridge_request_id=bridge_request_id,
            request_id=prompt.request_id,
        )
        pending = PendingExplicitConfirmation(
            bridge_request_id=bridge_request_id,
            request_id=prompt.request_id,
            action=prompt.action,
            original_payload=original_payload,
            prompt=prompt_payload,
            created_at=utc_now_iso(),
            metadata={
                "source": "local_wrapper",
                "preflight": _preflight_payload(preflight),
            },
        )
        self.set_pending_explicit_confirmation(pending_key, pending)

        return _result_from_preflight(
            preflight,
            bridge_request_id=bridge_request_id,
            ok=True,
            routed=False,
            blocked=False,
            route_reason="explicit_confirmation_required",
            summary=(
                "Explicit confirmation required before routing. "
                f"{prompt.instruction}"
            ),
            metadata={
                "explicit_confirmation_required": True,
                "confirmation_phrase": prompt.confirmation_phrase,
                "instruction": prompt.instruction,
                "pending_key": pending_key,
            },
        )

    def _find_pending_explicit_confirmation(
        self,
        *,
        bridge_request_id: Optional[str],
        request_id: Optional[str],
    ) -> tuple[Optional[str], Optional[PendingExplicitConfirmation]]:
        for key in [bridge_request_id, request_id]:
            if key and key in self._pending_explicit_confirmations:
                return key, self._pending_explicit_confirmations[key]

        if bridge_request_id:
            for key, pending in self._pending_explicit_confirmations.items():
                if pending.bridge_request_id == bridge_request_id:
                    return key, pending
        if request_id:
            for key, pending in self._pending_explicit_confirmations.items():
                if pending.request_id == request_id:
                    return key, pending

        return None, None

    def _route_explicitly_confirmed_payload(
        self,
        pending: PendingExplicitConfirmation,
    ) -> WrapperRouteResult:
        prompt = ExplicitConfirmationPrompt(**pending.prompt)
        initial_result = self._route_payload(
            pending.original_payload,
            bridge_request_id=pending.bridge_request_id,
            route_reason="explicit_confirmation_matched",
            summary_action=pending.action,
            summary_category=prompt.category,
            preflight=None,
            metadata={
                "explicit_confirmation_matched": True,
                "phase": "sensitive_payload_routed",
            },
        )
        if not _bridge_response_requires_confirmation(initial_result.bridge_response):
            return initial_result

        confirmation_payload = _confirmation_payload_for(pending.original_payload)
        confirmation_bridge_request_id = (
            f"{pending.bridge_request_id}-explicit-confirmation"
        )
        confirmation_result = self._route_payload(
            confirmation_payload,
            bridge_request_id=confirmation_bridge_request_id,
            route_reason="explicit_confirmation_matched",
            summary_action=pending.action,
            summary_category=prompt.category,
            preflight=None,
            metadata={
                "explicit_confirmation_matched": True,
                "initial_bridge_response": initial_result.bridge_response,
                "confirmation_bridge_request_id": confirmation_bridge_request_id,
            },
        )
        return _result(
            ok=confirmation_result.ok,
            bridge_request_id=pending.bridge_request_id,
            routed=True,
            blocked=False,
            route_reason="explicit_confirmation_matched",
            action=pending.action,
            category=prompt.category,
            bridge_response=confirmation_result.bridge_response,
            error_type=confirmation_result.error_type,
            error_message=confirmation_result.error_message,
            summary="Explicit confirmation matched and payload was routed.",
            metadata={
                "explicit_confirmation_matched": True,
                "initial_bridge_response": initial_result.bridge_response,
                "confirmation_bridge_request_id": confirmation_bridge_request_id,
            },
        )

    def _route_payload(
        self,
        payload: dict[str, Any],
        *,
        bridge_request_id: str,
        route_reason: str,
        summary_action: Optional[str],
        summary_category: Optional[str],
        preflight: Optional[PermissionPreflightResult],
        metadata: Optional[dict[str, Any]] = None,
    ) -> WrapperRouteResult:
        if self._client is None:
            return _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=False,
                blocked=True,
                route_reason="bridge_not_running",
                summary="Bridge is not running.",
                error_type="BridgeNotRunning",
                error_message="Bridge is not running.",
            )

        request = _bridge_request(
            bridge_request_id,
            "handle_payload",
            payload=dict(payload),
        )
        try:
            response = self._client.send(request)
        except Exception as exc:
            return _result(
                ok=False,
                bridge_request_id=bridge_request_id,
                routed=True,
                blocked=False,
                route_reason=route_reason,
                action=summary_action,
                category=summary_category,
                preflight=_preflight_payload(preflight),
                summary=f"Bridge routing failed: {exc}",
                error_type="BridgeRequestFailed",
                error_message=str(exc),
                metadata=metadata,
            )

        response_valid = _valid_bridge_response(response)
        bridge_ok = response_valid and bool(response.get("ok"))
        return _result(
            ok=bridge_ok,
            bridge_request_id=bridge_request_id,
            routed=True,
            blocked=False,
            route_reason=route_reason,
            action=summary_action,
            category=summary_category,
            requires_confirmation=preflight.requires_confirmation
            if preflight is not None
            else False,
            requires_explicit_confirmation=preflight.requires_explicit_confirmation
            if preflight is not None
            else False,
            preflight=_preflight_payload(preflight),
            bridge_response=to_jsonable(response),
            error_type=None if bridge_ok else _bridge_error_type(response),
            error_message=None if bridge_ok else _bridge_error_message(response),
            summary="Payload routed to bridge."
            if bridge_ok
            else "Payload routed to bridge but bridge returned an error.",
            metadata=metadata,
        )


def _bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "bridge_request_id": bridge_request_id,
        "type": request_type,
        "payload": payload or {},
    }


def _result(
    *,
    ok: bool,
    bridge_request_id: Optional[str],
    routed: bool,
    blocked: bool,
    route_reason: str,
    summary: str,
    action: Optional[str] = None,
    category: Optional[str] = None,
    requires_confirmation: bool = False,
    requires_explicit_confirmation: bool = False,
    preflight: Optional[dict[str, Any]] = None,
    bridge_response: Optional[dict[str, Any]] = None,
    error_type: Optional[str] = None,
    error_message: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> WrapperRouteResult:
    return WrapperRouteResult(
        ok=ok,
        bridge_request_id=bridge_request_id,
        routed=routed,
        blocked=blocked,
        route_reason=route_reason,
        action=action,
        category=category,
        requires_confirmation=requires_confirmation,
        requires_explicit_confirmation=requires_explicit_confirmation,
        preflight=preflight,
        bridge_response=bridge_response,
        error_type=error_type,
        error_message=error_message,
        summary=summary,
        metadata=to_jsonable(metadata or {}),
    )


def _result_from_preflight(
    preflight: PermissionPreflightResult,
    *,
    bridge_request_id: str,
    ok: bool,
    routed: bool,
    blocked: bool,
    route_reason: str,
    summary: str,
    metadata: Optional[dict[str, Any]] = None,
) -> WrapperRouteResult:
    return _result(
        ok=ok,
        bridge_request_id=bridge_request_id,
        routed=routed,
        blocked=blocked,
        route_reason=route_reason,
        action=preflight.action,
        category=preflight.category,
        requires_confirmation=preflight.requires_confirmation,
        requires_explicit_confirmation=preflight.requires_explicit_confirmation,
        preflight=_preflight_payload(preflight),
        error_type=preflight.error_type,
        error_message=preflight.error_message,
        summary=summary,
        metadata=metadata,
    )


def _blocked_preflight_result(
    preflight: PermissionPreflightResult,
    *,
    bridge_request_id: str,
    route_reason: str,
) -> WrapperRouteResult:
    ok = preflight.ok and preflight.category == FUTURE_HIGH_RISK
    return _result_from_preflight(
        preflight,
        bridge_request_id=bridge_request_id,
        ok=ok,
        routed=False,
        blocked=True,
        route_reason=route_reason,
        summary=f"Payload blocked: {preflight.reason}",
    )


def _preflight_payload(
    preflight: Optional[PermissionPreflightResult],
) -> Optional[dict[str, Any]]:
    if preflight is None:
        return None
    return permission_preflight_result_to_payload(preflight)


def _pending_explicit_confirmation_key(
    *,
    bridge_request_id: str,
    request_id: Optional[str],
) -> str:
    return bridge_request_id or request_id or "pending-explicit-confirmation"


def _confirmation_payload_for(payload: dict[str, Any]) -> dict[str, Any]:
    message = normalize_openclaw_message_payload(payload)
    confirmation_payload: dict[str, Any] = {
        "channelId": message.channel_id,
        "userId": message.user_id,
        "messageId": f"{message.message_id}-explicit-confirmation",
        "content": "yes",
        "createdAt": message.timestamp,
    }
    if message.thread_id is not None:
        confirmation_payload["threadId"] = message.thread_id
    if message.message_id:
        confirmation_payload["replyToMessageId"] = message.message_id
    return confirmation_payload


def _bridge_response_requires_confirmation(
    bridge_response: Optional[dict[str, Any]],
) -> bool:
    if not isinstance(bridge_response, dict):
        return False
    payload = bridge_response.get("response")
    if not isinstance(payload, dict):
        return False
    return (
        payload.get("event_type") == "pending_confirmation"
        or payload.get("requires_confirmation") is True
    )


def _response_has_pong(response: dict[str, Any]) -> bool:
    payload = response.get("response")
    return isinstance(payload, dict) and payload.get("pong") is True


def _valid_bridge_response(response: dict[str, Any]) -> bool:
    return validate_stdout_response_line(json.dumps(response)).ok


def _bridge_error_type(response: dict[str, Any]) -> Optional[str]:
    error_type = _string(response.get("error_type"))
    if error_type:
        return error_type
    payload = response.get("response")
    if isinstance(payload, dict):
        return _string(payload.get("error_type"))
    return "InvalidBridgeResponse"


def _bridge_error_message(response: dict[str, Any]) -> Optional[str]:
    error_message = _string(response.get("error_message"))
    if error_message:
        return error_message
    payload = response.get("response")
    if isinstance(payload, dict):
        return _string(payload.get("text"))
    return "Bridge response was invalid or failed."


def _string(value: object) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    return None
