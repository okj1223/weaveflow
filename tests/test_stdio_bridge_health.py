import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters.diagnostics import create_diagnostic_event
from projectops.adapters.stdio_health import (
    BridgeHealthResult,
    BridgeLineValidationResult,
    check_bridge_subprocess_health,
    summarize_bridge_failure,
    validate_stderr_diagnostic_line,
    validate_stdout_response_line,
)
from projectops.json_io import CONTRACT_VERSION, to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "stdio_bridge_health_demo.py"
HEALTH_DOC = ROOT / "docs" / "stdio_bridge_health_checks.md"


def stdout_response_line(
    *,
    bridge_request_id: str = "health-ping",
    response: dict[str, object] | None = None,
) -> str:
    return json.dumps(
        {
            "contract_version": CONTRACT_VERSION,
            "bridge_request_id": bridge_request_id,
            "ok": True,
            "type": "ping",
            "response": response or {"pong": True},
            "error_type": None,
            "error_message": None,
        }
    )


def stderr_diagnostic_line() -> str:
    return json.dumps(
        to_jsonable(create_diagnostic_event("bridge_started", message="started"))
    )


def test_stdio_bridge_health_imports() -> None:
    assert BridgeLineValidationResult
    assert BridgeHealthResult
    assert validate_stdout_response_line
    assert validate_stderr_diagnostic_line
    assert check_bridge_subprocess_health


def test_validate_valid_stdout_response_line() -> None:
    result = validate_stdout_response_line(stdout_response_line())

    assert result.ok is True
    assert result.parsed is not None
    assert result.parsed["bridge_request_id"] == "health-ping"


def test_invalid_stdout_non_json() -> None:
    result = validate_stdout_response_line("not json")

    assert result.ok is False
    assert result.error_type


def test_invalid_stdout_missing_fields() -> None:
    result = validate_stdout_response_line(json.dumps({"contract_version": "x"}))

    assert result.ok is False
    assert result.error_type == "InvalidBridgeStdoutShape"


def test_validate_valid_stderr_diagnostic_line() -> None:
    result = validate_stderr_diagnostic_line(stderr_diagnostic_line())

    assert result.ok is True
    assert result.parsed is not None
    assert result.parsed["event"] == "bridge_started"


def test_invalid_stderr_non_json() -> None:
    result = validate_stderr_diagnostic_line("not json")

    assert result.ok is False
    assert result.error_type


def test_invalid_stderr_missing_fields() -> None:
    result = validate_stderr_diagnostic_line(json.dumps({"contract_version": "x"}))

    assert result.ok is False
    assert result.error_type == "InvalidBridgeDiagnosticShape"


def test_ping_health_check_passes(tmp_path: Path) -> None:
    result = check_bridge_subprocess_health(tmp_path)

    assert result.ok is True
    assert result.pong is True
    assert result.stdout_valid is True
    assert result.summary


def test_diagnostics_health_check_validates_stderr(tmp_path: Path) -> None:
    result = check_bridge_subprocess_health(tmp_path, diagnostics=True)

    assert result.ok is True
    assert result.stderr_valid is True
    assert result.diagnostics
    events = [diagnostic["event"] for diagnostic in result.diagnostics]
    assert "bridge_started" in events or "request_completed" in events


def test_wrong_ping_response_fails() -> None:
    response = validate_stdout_response_line(stdout_response_line(response={"pong": False}))
    stdout_errors: list[BridgeLineValidationResult] = []
    stderr_errors: list[BridgeLineValidationResult] = []

    result = BridgeHealthResult(
        ok=False,
        bridge_request_id="health-ping",
        pong=False,
        stdout_valid=response.ok,
        stderr_valid=True,
        error_type="MissingPong",
        error_message="Bridge ping response did not contain pong=true.",
        summary=summarize_bridge_failure(stdout_errors, stderr_errors),
        response=response.parsed,
        diagnostics=[],
    )

    assert result.ok is False
    assert "pong" in result.summary


def test_failure_summary() -> None:
    invalid = validate_stdout_response_line("not json")
    summary = summarize_bridge_failure([invalid], [])

    assert summary
    assert "Bridge health check failed" in summary


def test_stdio_bridge_health_demo_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        [sys.executable, str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == 0, result.stderr
    for term in ["ok", "pong", "stdout_valid", "summary"]:
        assert term in result.stdout


def test_stdio_bridge_health_docs() -> None:
    assert HEALTH_DOC.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    supervision = (
        ROOT / "docs" / "stdio_bridge_process_supervision.md"
    ).read_text(encoding="utf-8")
    client = (ROOT / "docs" / "stdio_bridge_client_contract.md").read_text(
        encoding="utf-8"
    )
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )
    doc = HEALTH_DOC.read_text(encoding="utf-8")

    assert "docs/stdio_bridge_health_checks.md" in readme
    assert "health check" in supervision.lower()
    assert "health check" in client.lower()
    assert "ping health check" in protocol.lower()
    for term in [
        "ping",
        "StdioBridgeResponse",
        "DiagnosticEvent",
        "stdout",
        "stderr",
        "pong",
        "wrapper",
        "OpenClaw",
        "no server",
        "no authentication",
    ]:
        assert term in doc
