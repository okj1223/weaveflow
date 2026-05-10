"""Local wrapper smoke flow for stdio bridge routing decisions."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.confirmation import is_confirmation_response
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
            return _result_from_preflight(
                preflight,
                bridge_request_id=bridge_request_id,
                ok=True,
                routed=False,
                blocked=False,
                route_reason="explicit_confirmation_required",
                summary="Explicit confirmation required before routing.",
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

    def shutdown(self) -> Optional[WrapperRouteResult]:
        """Shutdown the bridge subprocess if it is running."""

        if self._client is None:
            return None
        if not self._client.is_running():
            self._client.close()
            self._client = None
            self._health = None
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

    def _route_payload(
        self,
        payload: dict[str, Any],
        *,
        bridge_request_id: str,
        route_reason: str,
        summary_action: Optional[str],
        summary_category: Optional[str],
        preflight: Optional[PermissionPreflightResult],
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
