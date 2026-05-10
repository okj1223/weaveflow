"""Health-check helpers for local stdio bridge wrappers."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.diagnostics import DIAGNOSTIC_VERSION
from projectops.json_io import CONTRACT_VERSION, to_jsonable


STDOUT_RESPONSE_FIELDS = {
    "contract_version",
    "bridge_request_id",
    "ok",
    "type",
    "response",
    "error_type",
    "error_message",
}
STDERR_DIAGNOSTIC_FIELDS = {
    "contract_version",
    "diagnostic_version",
    "level",
    "event",
    "message",
    "timestamp",
    "metadata",
}


class BridgeLineValidationResult(BaseModel):
    ok: bool
    line_type: str
    parsed: Optional[dict[str, Any]] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None


class BridgeHealthResult(BaseModel):
    ok: bool
    bridge_request_id: str
    pong: bool
    stdout_valid: bool
    stderr_valid: bool
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    summary: str
    response: Optional[dict[str, Any]] = None
    diagnostics: list[dict[str, Any]] = Field(default_factory=list)


def validate_stdout_response_line(line: str) -> BridgeLineValidationResult:
    """Validate that one stdout line looks like a bridge response."""

    parsed = _parse_json_object(line, line_type="stdout_response")
    if not parsed.ok or parsed.parsed is None:
        return parsed

    payload = parsed.parsed
    missing = sorted(STDOUT_RESPONSE_FIELDS.difference(payload))
    if missing:
        return _invalid_line(
            "stdout_response",
            "InvalidBridgeStdoutShape",
            f"Bridge stdout response missing fields: {', '.join(missing)}.",
            payload,
        )

    if payload.get("contract_version") != CONTRACT_VERSION:
        return _invalid_line(
            "stdout_response",
            "UnsupportedContractVersion",
            "Bridge stdout response has unsupported contract_version.",
            payload,
        )
    if not isinstance(payload.get("bridge_request_id"), str):
        return _invalid_line(
            "stdout_response",
            "InvalidBridgeStdoutShape",
            "Bridge stdout response bridge_request_id must be a string.",
            payload,
        )
    if not isinstance(payload.get("ok"), bool):
        return _invalid_line(
            "stdout_response",
            "InvalidBridgeStdoutShape",
            "Bridge stdout response ok must be a boolean.",
            payload,
        )
    if not isinstance(payload.get("type"), str):
        return _invalid_line(
            "stdout_response",
            "InvalidBridgeStdoutShape",
            "Bridge stdout response type must be a string.",
            payload,
        )
    if payload.get("response") is not None and not isinstance(
        payload.get("response"),
        dict,
    ):
        return _invalid_line(
            "stdout_response",
            "InvalidBridgeStdoutShape",
            "Bridge stdout response response must be an object or null.",
            payload,
        )

    return parsed


def validate_stderr_diagnostic_line(line: str) -> BridgeLineValidationResult:
    """Validate that one stderr line looks like a diagnostic event."""

    if not line.strip():
        return _invalid_line(
            "stderr_diagnostic",
            "InvalidBridgeDiagnosticLine",
            "Bridge stderr diagnostic line is empty.",
        )

    parsed = _parse_json_object(line, line_type="stderr_diagnostic")
    if not parsed.ok or parsed.parsed is None:
        return parsed

    payload = parsed.parsed
    missing = sorted(STDERR_DIAGNOSTIC_FIELDS.difference(payload))
    if missing:
        return _invalid_line(
            "stderr_diagnostic",
            "InvalidBridgeDiagnosticShape",
            f"Bridge stderr diagnostic missing fields: {', '.join(missing)}.",
            payload,
        )

    if payload.get("contract_version") != CONTRACT_VERSION:
        return _invalid_line(
            "stderr_diagnostic",
            "UnsupportedContractVersion",
            "Bridge stderr diagnostic has unsupported contract_version.",
            payload,
        )
    if payload.get("diagnostic_version") != DIAGNOSTIC_VERSION:
        return _invalid_line(
            "stderr_diagnostic",
            "UnsupportedDiagnosticVersion",
            "Bridge stderr diagnostic has unsupported diagnostic_version.",
            payload,
        )
    for field in ["level", "event", "message", "timestamp"]:
        if not isinstance(payload.get(field), str):
            return _invalid_line(
                "stderr_diagnostic",
                "InvalidBridgeDiagnosticShape",
                f"Bridge stderr diagnostic {field} must be a string.",
                payload,
            )
    if not isinstance(payload.get("metadata"), dict):
        return _invalid_line(
            "stderr_diagnostic",
            "InvalidBridgeDiagnosticShape",
            "Bridge stderr diagnostic metadata must be an object.",
            payload,
        )

    return parsed


def summarize_bridge_failure(
    stdout_errors: list[BridgeLineValidationResult],
    stderr_errors: list[BridgeLineValidationResult],
    process_exit_code: Optional[int] = None,
) -> str:
    """Create a clean one-sentence bridge health failure summary."""

    if process_exit_code not in (None, 0):
        return f"Bridge process exited with code {process_exit_code}."
    if stdout_errors:
        message = stdout_errors[0].error_message or "stdout response was invalid."
        return f"Bridge health check failed: {message}"
    if stderr_errors:
        message = stderr_errors[0].error_message or "stderr diagnostic was invalid."
        return f"Bridge health check failed: {message}"
    return "Bridge health check failed: ping response did not contain pong=true."


def check_bridge_subprocess_health(
    root: Path,
    diagnostics: bool = False,
    timeout: float = 5.0,
) -> BridgeHealthResult:
    """Run a one-shot bridge subprocess ping health check."""

    bridge_request_id = "health-ping"
    requests = [
        _bridge_request(bridge_request_id, "ping"),
        _bridge_request("health-shutdown", "shutdown"),
    ]
    command = [
        sys.executable,
        "-m",
        "projectops.adapters.stdio_bridge",
        "--root",
        str(root),
    ]
    if diagnostics:
        command.append("--diagnostics-stderr")

    try:
        completed = subprocess.run(
            command,
            input="\n".join(requests) + "\n",
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return BridgeHealthResult(
            ok=False,
            bridge_request_id=bridge_request_id,
            pong=False,
            stdout_valid=False,
            stderr_valid=False,
            error_type="BridgeHealthTimeout",
            error_message="Bridge health check timed out.",
            summary="Bridge health check failed: process timed out.",
        )

    stdout_results = [
        validate_stdout_response_line(line) for line in completed.stdout.splitlines()
    ]
    stderr_results = [
        validate_stderr_diagnostic_line(line) for line in completed.stderr.splitlines()
    ]
    stdout_errors = [result for result in stdout_results if not result.ok]
    stderr_errors = [result for result in stderr_results if not result.ok]
    stdout_valid = bool(stdout_results) and not stdout_errors
    stderr_valid = not stderr_errors
    diagnostics_payloads = [
        result.parsed for result in stderr_results if result.ok and result.parsed
    ]
    ping_response = _find_response(stdout_results, bridge_request_id)
    pong = _has_pong(ping_response)
    ok = completed.returncode == 0 and stdout_valid and stderr_valid and pong

    error_type = None
    error_message = None
    summary = "Bridge health check passed."
    if not ok:
        if completed.returncode != 0:
            error_type = "BridgeProcessExited"
            error_message = f"Bridge process exited with code {completed.returncode}."
        elif stdout_errors:
            error_type = stdout_errors[0].error_type
            error_message = stdout_errors[0].error_message
        elif stderr_errors:
            error_type = stderr_errors[0].error_type
            error_message = stderr_errors[0].error_message
        elif not pong:
            error_type = "MissingPong"
            error_message = "Bridge ping response did not contain pong=true."
        else:
            error_type = "BridgeHealthCheckFailed"
            error_message = "Bridge health check failed."
        summary = summarize_bridge_failure(
            stdout_errors,
            stderr_errors,
            process_exit_code=completed.returncode,
        )

    return BridgeHealthResult(
        ok=ok,
        bridge_request_id=bridge_request_id,
        pong=pong,
        stdout_valid=stdout_valid,
        stderr_valid=stderr_valid,
        error_type=error_type,
        error_message=error_message,
        summary=summary,
        response=ping_response,
        diagnostics=[to_jsonable(item) for item in diagnostics_payloads],
    )


def _parse_json_object(line: str, *, line_type: str) -> BridgeLineValidationResult:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return _invalid_line(
            line_type,
            "InvalidBridgeJsonLine",
            f"Bridge {line_type} line was not valid JSON.",
        )

    if not isinstance(parsed, dict):
        return _invalid_line(
            line_type,
            "InvalidBridgeJsonLine",
            f"Bridge {line_type} line was not a JSON object.",
        )
    return BridgeLineValidationResult(ok=True, line_type=line_type, parsed=parsed)


def _invalid_line(
    line_type: str,
    error_type: str,
    error_message: str,
    parsed: Optional[dict[str, Any]] = None,
) -> BridgeLineValidationResult:
    return BridgeLineValidationResult(
        ok=False,
        line_type=line_type,
        parsed=parsed,
        error_type=error_type,
        error_message=error_message,
    )


def _bridge_request(bridge_request_id: str, request_type: str) -> str:
    return json.dumps(
        {
            "contract_version": CONTRACT_VERSION,
            "bridge_request_id": bridge_request_id,
            "type": request_type,
            "payload": {},
        }
    )


def _find_response(
    results: list[BridgeLineValidationResult],
    bridge_request_id: str,
) -> Optional[dict[str, Any]]:
    for result in results:
        payload = result.parsed
        if result.ok and payload and payload.get("bridge_request_id") == bridge_request_id:
            return payload
    return None


def _has_pong(response: Optional[dict[str, Any]]) -> bool:
    if not response:
        return False
    payload = response.get("response")
    return isinstance(payload, dict) and payload.get("pong") is True
