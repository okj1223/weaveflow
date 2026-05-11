import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from weaveflow.json_io import CONTRACT_VERSION


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "stdio_bridge_diagnostics_capture_demo.py"


def bridge_command(root: Path, diagnostics: bool = False) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "weaveflow.adapters.stdio_bridge",
        "--root",
        str(root),
    ]
    if diagnostics:
        command.append("--diagnostics-stderr")
    return command


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, Any] | None = None,
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


def run_bridge_subprocess(
    root: Path,
    lines: list[str],
    *,
    diagnostics: bool = False,
) -> tuple[int, list[str], list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    result = subprocess.run(
        bridge_command(root, diagnostics=diagnostics),
        input="\n".join(lines) + "\n",
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    stdout_lines = result.stdout.splitlines()
    stderr_lines = result.stderr.splitlines()
    stdout_json = [json.loads(line) for line in stdout_lines]
    stderr_json = [json.loads(line) for line in stderr_lines]
    return result.returncode, stdout_lines, stderr_lines, stdout_json, stderr_json


def test_module_entrypoint_help_lists_diagnostics_flag() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "weaveflow.adapters.stdio_bridge",
            "--help",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == 0
    assert "--diagnostics-stderr" in result.stdout


def test_default_subprocess_emits_stdout_json_without_required_diagnostics(
    tmp_path: Path,
) -> None:
    exit_code, stdout_lines, stderr_lines, stdout_json, _stderr_json = (
        run_bridge_subprocess(
            tmp_path,
            [
                bridge_request("bridge-ping", "ping"),
                bridge_request("bridge-shutdown", "shutdown"),
            ],
        )
    )

    assert exit_code == 0
    assert len(stdout_lines) == 2
    assert stderr_lines == []
    assert [item["type"] for item in stdout_json] == ["ping", "shutdown"]
    for item in stdout_json:
        assert item["contract_version"] == CONTRACT_VERSION
        assert "bridge_request_id" in item
        assert "diagnostic_version" not in item


def test_diagnostics_subprocess_emits_stderr_json_diagnostics(
    tmp_path: Path,
) -> None:
    exit_code, _stdout_lines, stderr_lines, _stdout_json, stderr_json = (
        run_bridge_subprocess(
            tmp_path,
            [
                bridge_request("bridge-ping", "ping"),
                bridge_request("bridge-shutdown", "shutdown"),
            ],
            diagnostics=True,
        )
    )

    assert exit_code == 0
    assert stderr_lines
    events = [item["event"] for item in stderr_json]
    for event in [
        "bridge_started",
        "request_received",
        "request_completed",
        "shutdown_requested",
        "bridge_stopped",
    ]:
        assert event in events


def test_stdout_and_stderr_are_not_mixed(tmp_path: Path) -> None:
    _exit_code, stdout_lines, stderr_lines, stdout_json, stderr_json = (
        run_bridge_subprocess(
            tmp_path,
            [
                bridge_request("bridge-ping", "ping"),
                bridge_request("bridge-shutdown", "shutdown"),
            ],
            diagnostics=True,
        )
    )

    assert stdout_lines
    assert stderr_lines
    for item in stdout_json:
        assert {"contract_version", "bridge_request_id", "ok", "type"} <= set(item)
        assert "diagnostic_version" not in item
    for item in stderr_json:
        assert {
            "contract_version",
            "diagnostic_version",
            "level",
            "event",
            "message",
        } <= set(item)
        assert not {"ok", "type", "response", "error_message"} <= set(item)


def test_invalid_json_produces_stdout_error_and_stderr_diagnostic(
    tmp_path: Path,
) -> None:
    _exit_code, _stdout_lines, _stderr_lines, stdout_json, stderr_json = (
        run_bridge_subprocess(
            tmp_path,
            ["{not json", bridge_request("bridge-shutdown", "shutdown")],
            diagnostics=True,
        )
    )

    assert stdout_json[0]["ok"] is False
    assert stdout_json[0]["error_type"] == "InvalidBridgeJson"
    assert "protocol_error" in [item["event"] for item in stderr_json]


def test_session_state_preserved_across_subprocess_request_lines(
    tmp_path: Path,
) -> None:
    _exit_code, _stdout_lines, _stderr_lines, stdout_json, _stderr_json = (
        run_bridge_subprocess(
            tmp_path,
            [
                bridge_request(
                    "init",
                    "handle_payload",
                    channel_payload("init workspace", "m1"),
                ),
                bridge_request("init-yes", "handle_payload", channel_payload("yes", "m2")),
                bridge_request(
                    "create",
                    "handle_payload",
                    channel_payload("create task Diagnostics capture flow", "m3"),
                ),
                bridge_request(
                    "create-yes",
                    "handle_payload",
                    channel_payload("yes", "m4"),
                ),
                bridge_request(
                    "doctor",
                    "handle_payload",
                    channel_payload("doctor", "m5"),
                ),
                bridge_request("shutdown", "shutdown"),
            ],
            diagnostics=True,
        )
    )

    assert stdout_json[0]["response"]["event_type"] == "pending_confirmation"
    assert stdout_json[1]["response"]["event_type"] == "turn_completed"
    assert stdout_json[2]["response"]["event_type"] == "pending_confirmation"
    assert stdout_json[3]["response"]["event_type"] == "turn_completed"
    assert stdout_json[4]["response"]["ok"] is True
    assert (tmp_path / ".weaveflow").exists()
    assert (
        tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_stdio_bridge_diagnostics_capture_demo_runs() -> None:
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
    for term in [
        "stdout response count",
        "stderr diagnostic count",
        "stdout_json_only",
        "stderr_json_only",
        "bridge_started",
        "shutdown_requested",
    ]:
        assert term in result.stdout


def test_stdio_bridge_diagnostics_capture_docs() -> None:
    diagnostics = (
        ROOT / "docs" / "stdio_bridge_diagnostics_contract.md"
    ).read_text(encoding="utf-8")
    supervision = (
        ROOT / "docs" / "stdio_bridge_process_supervision.md"
    ).read_text(encoding="utf-8")
    client = (ROOT / "docs" / "stdio_bridge_client_contract.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "--diagnostics-stderr" in diagnostics
    assert "capturing stderr diagnostics from subprocess" in supervision
    assert "--diagnostics-stderr" in client
    assert "stdio_bridge_diagnostics_capture_demo.py" in readme


def test_no_real_openclaw_import_dependency() -> None:
    for path in [
        ROOT / "src" / "weaveflow" / "adapters" / "stdio_bridge.py",
        DEMO_PATH,
    ]:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip().lower()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")
