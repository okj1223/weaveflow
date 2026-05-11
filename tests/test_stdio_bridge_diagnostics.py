import io
import json
import subprocess
from pathlib import Path

import pytest

from weaveflow.adapters.diagnostics import (
    DIAGNOSTIC_VERSION,
    DiagnosticEvent,
    DiagnosticWriter,
    create_diagnostic_event,
    diagnostic_event_to_json_line,
    sanitize_diagnostic_metadata,
)
from weaveflow.adapters.openclaw import OpenClawAdapter
from weaveflow.adapters.stdio_bridge import process_bridge_line, run_stdio_bridge
from weaveflow.json_io import CONTRACT_VERSION


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "stdio_bridge_diagnostics_demo.py"


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, object] | None = None,
) -> str:
    return json.dumps(
        {
            "contract_version": CONTRACT_VERSION,
            "bridge_request_id": bridge_request_id,
            "type": request_type,
            "payload": payload or {},
        }
    )


def channel_payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def run_bridge_with_diagnostics(
    tmp_path: Path,
    lines: list[str],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    input_stream = io.StringIO("\n".join(lines) + "\n")
    output_stream = io.StringIO()
    diagnostics_stream = io.StringIO()
    writer = DiagnosticWriter(diagnostics_stream)

    exit_code = run_stdio_bridge(
        tmp_path,
        input_stream,
        output_stream,
        diagnostic_writer=writer,
    )

    assert exit_code == 0
    responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
    diagnostics = [
        json.loads(line) for line in diagnostics_stream.getvalue().splitlines()
    ]
    return responses, diagnostics


def test_stdio_bridge_diagnostics_imports() -> None:
    assert DiagnosticEvent
    assert DiagnosticWriter
    assert DIAGNOSTIC_VERSION == "weaveflow.diagnostics.v1"
    assert create_diagnostic_event
    assert diagnostic_event_to_json_line
    assert sanitize_diagnostic_metadata


def test_create_diagnostic_event() -> None:
    event = create_diagnostic_event(
        "bridge_started",
        level="info",
        message="started",
        bridge_request_id="bridge-1",
        request_id="m1",
        action="status",
        metadata={"ok": True},
    )

    assert event.contract_version == CONTRACT_VERSION
    assert event.diagnostic_version == DIAGNOSTIC_VERSION
    assert event.level == "info"
    assert event.event == "bridge_started"
    assert event.timestamp
    assert event.metadata["ok"] is True


def test_invalid_level() -> None:
    with pytest.raises(ValueError):
        create_diagnostic_event("request_failed", level="bad")


def test_event_json_line_parses() -> None:
    event = create_diagnostic_event("request_completed", message="done")
    parsed = json.loads(diagnostic_event_to_json_line(event))

    assert parsed["contract_version"] == CONTRACT_VERSION
    assert parsed["diagnostic_version"] == DIAGNOSTIC_VERSION
    assert parsed["event"] == "request_completed"
    assert parsed["metadata"] == {}


def test_writer_writes_one_json_line() -> None:
    stream = io.StringIO()
    writer = DiagnosticWriter(stream)

    writer.write_event(create_diagnostic_event("bridge_started"))

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["event"] == "bridge_started"


def test_disabled_writer_writes_nothing() -> None:
    stream = io.StringIO()
    writer = DiagnosticWriter(stream, enabled=False)

    writer.write_event(create_diagnostic_event("bridge_started"))

    assert stream.getvalue() == ""


def test_metadata_json_safety() -> None:
    metadata = sanitize_diagnostic_metadata(
        {"path": Path("/tmp/example/file.txt"), "value": object()}
    )

    json.dumps(metadata)
    assert not isinstance(metadata["path"], Path)
    assert isinstance(metadata["value"], str)


def test_path_redaction() -> None:
    metadata = sanitize_diagnostic_metadata({"path": "/tmp/example/file.txt"})

    assert "/tmp/example/file.txt" not in metadata["path"]
    assert "<path>" in metadata["path"]


def test_run_stdio_bridge_stdout_remains_json_only_with_diagnostics(
    tmp_path: Path,
) -> None:
    responses, diagnostics = run_bridge_with_diagnostics(
        tmp_path,
        [
            bridge_request("bridge-ping", "ping"),
            bridge_request("bridge-shutdown", "shutdown"),
        ],
    )

    assert [response["type"] for response in responses] == ["ping", "shutdown"]
    assert all("diagnostic_version" not in response for response in responses)
    assert all(
        diagnostic["diagnostic_version"] == DIAGNOSTIC_VERSION
        for diagnostic in diagnostics
    )


def test_run_stdio_bridge_emits_lifecycle_diagnostics(tmp_path: Path) -> None:
    _responses, diagnostics = run_bridge_with_diagnostics(
        tmp_path,
        [
            bridge_request("bridge-ping", "ping"),
            bridge_request("bridge-shutdown", "shutdown"),
        ],
    )

    events = [diagnostic["event"] for diagnostic in diagnostics]
    for event in [
        "bridge_started",
        "request_received",
        "request_completed",
        "shutdown_requested",
        "bridge_stopped",
    ]:
        assert event in events


def test_invalid_json_emits_protocol_diagnostic_and_stdout_json_error(
    tmp_path: Path,
) -> None:
    responses, diagnostics = run_bridge_with_diagnostics(
        tmp_path,
        ["{not json", bridge_request("bridge-shutdown", "shutdown")],
    )

    assert responses[0]["ok"] is False
    assert responses[0]["error_type"] == "InvalidBridgeJson"
    assert "protocol_error" in [diagnostic["event"] for diagnostic in diagnostics]


def test_handle_payload_failed_normalization_emits_diagnostic(tmp_path: Path) -> None:
    responses, diagnostics = run_bridge_with_diagnostics(
        tmp_path,
        [
            bridge_request(
                "bridge-bad",
                "handle_payload",
                {"messageId": "bad-1"},
            ),
            bridge_request("bridge-shutdown", "shutdown"),
        ],
    )

    assert responses[0]["ok"] is False
    assert responses[0]["error_type"] == "OpenClawPayloadNormalizationError"
    assert "normalization_error" in [
        diagnostic["event"] for diagnostic in diagnostics
    ]


def test_default_run_stdio_bridge_needs_no_diagnostic_stream(tmp_path: Path) -> None:
    input_stream = io.StringIO(bridge_request("bridge-ping", "ping") + "\n")
    output_stream = io.StringIO()

    exit_code = run_stdio_bridge(tmp_path, input_stream, output_stream)

    assert exit_code == 0
    responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
    assert responses[0]["ok"] is True


def test_process_bridge_line_compatibility(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    parsed = json.loads(process_bridge_line(adapter, bridge_request("b-1", "ping")))

    assert parsed["ok"] is True
    assert parsed["response"]["pong"] is True


def test_stdio_bridge_diagnostics_demo_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    output = result.stdout
    for term in [
        "stdout",
        "diagnostics",
        "bridge_started",
        "request_completed",
        "shutdown_requested",
    ]:
        assert term in output


def test_stdio_bridge_diagnostics_docs() -> None:
    diagnostics = (
        ROOT / "docs" / "stdio_bridge_diagnostics_contract.md"
    ).read_text(encoding="utf-8")
    supervision = (
        ROOT / "docs" / "stdio_bridge_process_supervision.md"
    ).read_text(encoding="utf-8")
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )

    assert "DiagnosticEvent" in diagnostics
    assert "DiagnosticWriter" in diagnostics
    assert "weaveflow.diagnostics.v1" in diagnostics
    assert "diagnostics capture" in supervision or "capture stderr diagnostics" in supervision
    assert "stderr diagnostics" in protocol
