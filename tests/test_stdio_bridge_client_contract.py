import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from projectops.adapters.stdio_client import StdioBridgeClient
from projectops.json_io import CONTRACT_VERSION


ROOT = Path(__file__).resolve().parents[1]
CLIENT_DOC = ROOT / "docs" / "stdio_bridge_client_contract.md"
CLIENT_DEMO = ROOT / "examples" / "stdio_bridge_client_demo.py"


def bridge_command(root: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "projectops.adapters.stdio_bridge",
        "--root",
        str(root),
    ]


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "bridge_request_id": bridge_request_id,
        "type": request_type,
        "payload": payload or {},
    }


def channel_payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def send_request(
    process: subprocess.Popen[str],
    request: dict[str, Any],
) -> dict[str, Any]:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    assert line, "bridge process did not return a response line"
    parsed = json.loads(line)
    assert isinstance(parsed, dict)
    return parsed


def test_client_contract_doc_exists() -> None:
    assert CLIENT_DOC.exists()


def test_readme_links_to_client_contract() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/stdio_bridge_client_contract.md" in readme


def test_protocol_links_to_client_contract() -> None:
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )

    assert "stdio_bridge_client_contract.md" in protocol


def test_gap_analysis_mentions_client_process_wrapper() -> None:
    gap = (ROOT / "docs" / "openclaw_integration_gap_analysis.md").read_text(
        encoding="utf-8"
    )

    assert "stdio bridge client" in gap.lower() or "process wrapper" in gap.lower()


def test_client_contract_mentions_required_terms() -> None:
    doc = CLIENT_DOC.read_text(encoding="utf-8")

    for term in [
        "stdin",
        "stdout",
        "line-delimited JSON",
        "subprocess",
        "bridge_request_id",
        "handle_payload",
        "ping",
        "shutdown",
        "OpenClaw",
        "no server",
        "no network",
        "no authentication",
        "in-memory session",
        "source of truth",
        ".projectops",
        "SQLite",
    ]:
        assert term in doc


def test_module_entrypoint_smoke(tmp_path: Path) -> None:
    process = subprocess.Popen(
        bridge_command(tmp_path),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ping = send_request(process, bridge_request("bridge-ping", "ping"))
        assert ping["ok"] is True
        assert ping["response"]["pong"] is True

        shutdown = send_request(
            process,
            bridge_request("bridge-shutdown", "shutdown"),
        )
        assert shutdown["ok"] is True
        process.wait(timeout=5)
        assert process.returncode == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


def test_subprocess_bridge_session_flow(tmp_path: Path) -> None:
    client = StdioBridgeClient(bridge_command(tmp_path))
    client.start()
    try:
        status = client.send(
            bridge_request("status", "handle_payload", channel_payload("status", "m1"))
        )
        assert status["ok"] is True

        init = client.send(
            bridge_request(
                "init",
                "handle_payload",
                channel_payload("init workspace", "m2"),
            )
        )
        assert init["response"]["event_type"] == "pending_confirmation"

        init_yes = client.send(
            bridge_request("init-yes", "handle_payload", channel_payload("yes", "m3"))
        )
        assert init_yes["response"]["event_type"] == "turn_completed"
        assert (tmp_path / ".projectops").exists()

        create = client.send(
            bridge_request(
                "create",
                "handle_payload",
                channel_payload("create task Process wrapper flow", "m4"),
            )
        )
        assert create["response"]["event_type"] == "pending_confirmation"

        create_yes = client.send(
            bridge_request("create-yes", "handle_payload", channel_payload("yes", "m5"))
        )
        assert create_yes["response"]["event_type"] == "turn_completed"
        assert (
            tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"
        ).is_file()

        doctor = client.send(
            bridge_request("doctor", "handle_payload", channel_payload("doctor", "m6"))
        )
        assert doctor["ok"] is True
        assert doctor["response"]["ok"] is True

        shutdown = client.send(bridge_request("shutdown", "shutdown"))
        assert shutdown["ok"] is True
    finally:
        client.close()

    assert not client.is_running()


def test_bridge_stdout_is_json_only(tmp_path: Path) -> None:
    process = subprocess.Popen(
        bridge_command(tmp_path),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    lines: list[str] = []
    try:
        for request in [
            bridge_request("bridge-ping", "ping"),
            bridge_request(
                "bridge-status",
                "handle_payload",
                channel_payload("status", "m1"),
            ),
            bridge_request("bridge-shutdown", "shutdown"),
        ]:
            assert process.stdin is not None
            assert process.stdout is not None
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            line = process.stdout.readline()
            assert line
            lines.append(line)
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)

    for line in lines:
        parsed = json.loads(line)
        assert isinstance(parsed, dict)
        assert "bridge_request_id" in parsed


def test_stdio_bridge_client_helper(tmp_path: Path) -> None:
    client = StdioBridgeClient(bridge_command(tmp_path))
    client.start()
    try:
        assert client.is_running()
        response = client.send(bridge_request("bridge-ping", "ping"))
        assert response["ok"] is True
        assert response["response"]["pong"] is True
        shutdown = client.send(bridge_request("bridge-shutdown", "shutdown"))
        assert shutdown["ok"] is True
    finally:
        client.close()

    assert not client.is_running()


def test_stdio_bridge_client_demo_runs() -> None:
    assert CLIENT_DEMO.exists()

    result = subprocess.run(
        [sys.executable, str(CLIENT_DEMO)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    for term in ["ping", "status", "init", "create", "doctor", "shutdown"]:
        assert term in result.stdout


def test_no_real_openclaw_import_dependency() -> None:
    for path in [
        ROOT / "src" / "projectops" / "adapters" / "stdio_client.py",
        ROOT / "src" / "projectops" / "adapters" / "stdio_bridge.py",
        CLIENT_DEMO,
    ]:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip().lower()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")
