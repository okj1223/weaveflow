"""Line-delimited JSON stdio bridge for the local adapter pipeline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional, TextIO

from pydantic import BaseModel, Field

from projectops.adapters.diagnostics import (
    DiagnosticWriter,
    create_diagnostic_event,
)
from projectops.adapters.openclaw import OpenClawAdapter
from projectops.json_io import CONTRACT_VERSION, to_jsonable


SUPPORTED_BRIDGE_TYPES = {"ping", "handle_payload", "shutdown"}


class StdioBridgeError(ValueError):
    """Raised for normal bridge request validation failures."""

    def __init__(
        self,
        error_type: str,
        error_message: str,
        *,
        bridge_request_id: str = "",
        request_type: str = "invalid",
    ) -> None:
        super().__init__(error_message)
        self.error_type = error_type
        self.error_message = error_message
        self.bridge_request_id = bridge_request_id
        self.request_type = request_type


class StdioBridgeRequest(BaseModel):
    contract_version: str
    bridge_request_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class StdioBridgeResponse(BaseModel):
    contract_version: str = CONTRACT_VERSION
    bridge_request_id: str
    ok: bool
    type: str
    response: Optional[dict[str, Any]] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None


def parse_bridge_request(raw: str) -> StdioBridgeRequest:
    """Parse and validate one raw JSON bridge request line."""

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StdioBridgeError(
            "InvalidBridgeJson",
            "Invalid JSON request.",
        ) from exc

    if not isinstance(payload, dict):
        raise StdioBridgeError(
            "InvalidBridgeRequest",
            "Bridge request must be a JSON object.",
        )

    bridge_request_id = _string_value(payload.get("bridge_request_id"))
    request_type = _string_value(payload.get("type")) or "invalid"

    contract_version = payload.get("contract_version")
    if contract_version is None:
        raise StdioBridgeError(
            "InvalidBridgeRequest",
            "Missing required field: contract_version.",
            bridge_request_id=bridge_request_id,
            request_type=request_type,
        )
    if contract_version != CONTRACT_VERSION:
        raise StdioBridgeError(
            "UnsupportedContractVersion",
            f"Unsupported contract_version: {contract_version}.",
            bridge_request_id=bridge_request_id,
            request_type=request_type,
        )

    if not bridge_request_id:
        raise StdioBridgeError(
            "InvalidBridgeRequest",
            "Missing required field: bridge_request_id.",
            request_type=request_type,
        )

    if not request_type or request_type == "invalid":
        raise StdioBridgeError(
            "InvalidBridgeRequest",
            "Missing required field: type.",
            bridge_request_id=bridge_request_id,
        )
    if request_type not in SUPPORTED_BRIDGE_TYPES:
        raise StdioBridgeError(
            "UnsupportedBridgeRequestType",
            f"Unsupported bridge request type: {request_type}.",
            bridge_request_id=bridge_request_id,
            request_type=request_type,
        )

    request_payload = payload.get("payload", {})
    if request_payload is None:
        request_payload = {}
    if not isinstance(request_payload, dict):
        raise StdioBridgeError(
            "InvalidBridgeRequest",
            "Field payload must be an object.",
            bridge_request_id=bridge_request_id,
            request_type=request_type,
        )

    return StdioBridgeRequest(
        contract_version=contract_version,
        bridge_request_id=bridge_request_id,
        type=request_type,
        payload=dict(request_payload),
    )


def handle_bridge_request(
    adapter: OpenClawAdapter,
    request: StdioBridgeRequest,
) -> StdioBridgeResponse:
    """Handle one parsed bridge request."""

    if request.contract_version != CONTRACT_VERSION:
        return _error_response(
            bridge_request_id=request.bridge_request_id,
            request_type=request.type,
            error_type="UnsupportedContractVersion",
            error_message=f"Unsupported contract_version: {request.contract_version}.",
        )

    if request.type == "ping":
        return StdioBridgeResponse(
            bridge_request_id=request.bridge_request_id,
            ok=True,
            type=request.type,
            response={"pong": True},
        )

    if request.type == "handle_payload":
        response = adapter.handle_payload(request.payload)
        ok = bool(response.get("ok"))
        error_type = None if ok else _string_value(response.get("error_type"))
        error_message = None
        if not ok:
            error_message = _string_value(response.get("text")) or "Bridge payload failed."
        return StdioBridgeResponse(
            bridge_request_id=request.bridge_request_id,
            ok=ok,
            type=request.type,
            response=response,
            error_type=error_type,
            error_message=error_message,
        )

    if request.type == "shutdown":
        return StdioBridgeResponse(
            bridge_request_id=request.bridge_request_id,
            ok=True,
            type=request.type,
            response={"shutdown": True},
        )

    return _error_response(
        bridge_request_id=request.bridge_request_id,
        request_type=request.type,
        error_type="UnsupportedBridgeRequestType",
        error_message=f"Unsupported bridge request type: {request.type}.",
    )


def process_bridge_line(
    adapter: OpenClawAdapter,
    raw: str,
    diagnostic_writer: Optional[DiagnosticWriter] = None,
) -> str:
    """Process one JSON request line and return one JSON response string."""

    try:
        request = parse_bridge_request(raw)
        _write_diagnostic(
            diagnostic_writer,
            event="request_received",
            level="debug",
            message="Bridge request received.",
            bridge_request_id=request.bridge_request_id,
            metadata={"request_type": request.type},
        )
        response = handle_bridge_request(adapter, request)
    except StdioBridgeError as exc:
        response = _error_response(
            bridge_request_id=exc.bridge_request_id,
            request_type=exc.request_type,
            error_type=exc.error_type,
            error_message=exc.error_message,
        )
        _write_diagnostic(
            diagnostic_writer,
            event="protocol_error",
            level="warning",
            message=exc.error_message,
            bridge_request_id=exc.bridge_request_id or None,
            metadata={
                "error_type": exc.error_type,
                "request_type": exc.request_type,
            },
        )
    except Exception:
        response = _error_response(
            bridge_request_id="",
            request_type="invalid",
            error_type="UnexpectedBridgeError",
            error_message="Unexpected bridge error.",
        )
        _write_diagnostic(
            diagnostic_writer,
            event="unexpected_error",
            level="error",
            message="Unexpected bridge error.",
            metadata={"error_type": "UnexpectedBridgeError"},
        )
    else:
        if response.ok:
            _write_diagnostic(
                diagnostic_writer,
                event="request_completed",
                level="info",
                message="Bridge request completed.",
                bridge_request_id=response.bridge_request_id,
                request_id=_response_request_id(response),
                action=_response_action(response),
                metadata={"request_type": response.type},
            )
        else:
            event_name = _failed_response_event_name(response)
            _write_diagnostic(
                diagnostic_writer,
                event=event_name,
                level="warning",
                message=response.error_message or "Bridge request failed.",
                bridge_request_id=response.bridge_request_id or None,
                request_id=_response_request_id(response),
                action=_response_action(response),
                metadata={
                    "error_type": response.error_type,
                    "request_type": response.type,
                },
            )

    return json.dumps(to_jsonable(response), sort_keys=True)


def run_stdio_bridge(
    root: Path,
    input_stream: TextIO,
    output_stream: TextIO,
    *,
    stop_on_shutdown: bool = True,
    diagnostic_writer: Optional[DiagnosticWriter] = None,
) -> int:
    """Run a line-delimited JSON bridge over the provided streams."""

    adapter = OpenClawAdapter(root)
    _write_diagnostic(
        diagnostic_writer,
        event="bridge_started",
        level="info",
        message="ProjectOps stdio bridge started.",
    )
    try:
        for raw_line in input_stream:
            raw = raw_line.strip()
            if not raw:
                continue

            response_line = process_bridge_line(
                adapter,
                raw,
                diagnostic_writer=diagnostic_writer,
            )
            output_stream.write(response_line + "\n")
            output_stream.flush()

            if stop_on_shutdown and _is_shutdown_response(response_line):
                _write_diagnostic(
                    diagnostic_writer,
                    event="shutdown_requested",
                    level="info",
                    message="Bridge shutdown requested.",
                    bridge_request_id=_response_line_bridge_request_id(response_line),
                )
                break
    finally:
        _write_diagnostic(
            diagnostic_writer,
            event="bridge_stopped",
            level="info",
            message="ProjectOps stdio bridge stopped.",
        )

    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the ProjectOps adapter stdio JSON bridge."
    )
    parser.add_argument(
        "--root",
        default=".",
        help="ProjectOps workspace root for bridge requests.",
    )
    parser.add_argument(
        "--diagnostics-stderr",
        action="store_true",
        help="Emit structured diagnostic JSON lines to stderr.",
    )
    args = parser.parse_args(argv)
    diagnostic_writer = None
    if args.diagnostics_stderr:
        diagnostic_writer = DiagnosticWriter(stream=sys.stderr, enabled=True)
    return run_stdio_bridge(
        Path(args.root),
        sys.stdin,
        sys.stdout,
        diagnostic_writer=diagnostic_writer,
    )


def _error_response(
    *,
    bridge_request_id: str,
    request_type: str,
    error_type: str,
    error_message: str,
) -> StdioBridgeResponse:
    return StdioBridgeResponse(
        bridge_request_id=bridge_request_id,
        ok=False,
        type=request_type,
        response=None,
        error_type=error_type,
        error_message=error_message,
    )


def _string_value(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _is_shutdown_response(raw: str) -> bool:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return (
        isinstance(payload, dict)
        and payload.get("ok") is True
        and payload.get("type") == "shutdown"
    )


def _write_diagnostic(
    diagnostic_writer: Optional[DiagnosticWriter],
    *,
    event: str,
    level: str,
    message: str,
    bridge_request_id: Optional[str] = None,
    request_id: Optional[str] = None,
    action: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    if diagnostic_writer is None:
        return
    diagnostic_writer.write_event(
        create_diagnostic_event(
            event=event,
            level=level,
            message=message,
            bridge_request_id=bridge_request_id,
            request_id=request_id,
            action=action,
            metadata=metadata,
        )
    )


def _response_request_id(response: StdioBridgeResponse) -> Optional[str]:
    payload = response.response
    if isinstance(payload, dict):
        request_id = payload.get("request_id")
        if isinstance(request_id, str) and request_id:
            return request_id
    return None


def _response_action(response: StdioBridgeResponse) -> Optional[str]:
    payload = response.response
    if isinstance(payload, dict):
        metadata = payload.get("metadata")
        if isinstance(metadata, dict):
            action = metadata.get("action")
            if isinstance(action, str) and action:
                return action
    return None


def _failed_response_event_name(response: StdioBridgeResponse) -> str:
    if response.error_type == "OpenClawPayloadNormalizationError":
        return "normalization_error"
    return "request_failed"


def _response_line_bridge_request_id(raw: str) -> Optional[str]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    bridge_request_id = payload.get("bridge_request_id")
    if isinstance(bridge_request_id, str) and bridge_request_id:
        return bridge_request_id
    return None


if __name__ == "__main__":
    raise SystemExit(main())
