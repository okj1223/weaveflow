"""Line-delimited JSON stdio bridge for the local adapter pipeline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional, TextIO

from pydantic import BaseModel, Field

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


def process_bridge_line(adapter: OpenClawAdapter, raw: str) -> str:
    """Process one JSON request line and return one JSON response string."""

    try:
        request = parse_bridge_request(raw)
        response = handle_bridge_request(adapter, request)
    except StdioBridgeError as exc:
        response = _error_response(
            bridge_request_id=exc.bridge_request_id,
            request_type=exc.request_type,
            error_type=exc.error_type,
            error_message=exc.error_message,
        )
    except Exception:
        response = _error_response(
            bridge_request_id="",
            request_type="invalid",
            error_type="UnexpectedBridgeError",
            error_message="Unexpected bridge error.",
        )

    return json.dumps(to_jsonable(response), sort_keys=True)


def run_stdio_bridge(
    root: Path,
    input_stream: TextIO,
    output_stream: TextIO,
    *,
    stop_on_shutdown: bool = True,
) -> int:
    """Run a line-delimited JSON bridge over the provided streams."""

    adapter = OpenClawAdapter(root)
    for raw_line in input_stream:
        raw = raw_line.strip()
        if not raw:
            continue

        response_line = process_bridge_line(adapter, raw)
        output_stream.write(response_line + "\n")
        output_stream.flush()

        if stop_on_shutdown and _is_shutdown_response(response_line):
            break

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
    args = parser.parse_args(argv)
    return run_stdio_bridge(Path(args.root), sys.stdin, sys.stdout)


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


if __name__ == "__main__":
    raise SystemExit(main())
