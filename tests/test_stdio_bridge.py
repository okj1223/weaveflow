import io
import json
import subprocess
from pathlib import Path

from weaveflow.adapters.openclaw import OpenClawAdapter
from weaveflow.adapters.stdio_bridge import (
    StdioBridgeError,
    StdioBridgeRequest,
    StdioBridgeResponse,
    parse_bridge_request,
    process_bridge_line,
    run_stdio_bridge,
)
from weaveflow.json_io import CONTRACT_VERSION


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "stdio_bridge_demo.py"


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, object] | None = None,
    contract_version: str = CONTRACT_VERSION,
) -> str:
    return json.dumps(
        {
            "contract_version": contract_version,
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
        "createdAt": "2026-05-09T00:00:00Z",
        "threadId": "thread-1",
    }


def parsed_response(adapter: OpenClawAdapter, raw: str) -> dict[str, object]:
    return json.loads(process_bridge_line(adapter, raw))


def run_bridge(root: Path, lines: list[str]) -> list[dict[str, object]]:
    input_stream = io.StringIO("\n".join(lines) + "\n")
    output_stream = io.StringIO()

    exit_code = run_stdio_bridge(root, input_stream, output_stream)

    assert exit_code == 0
    return [json.loads(line) for line in output_stream.getvalue().splitlines()]


def test_stdio_bridge_imports() -> None:
    assert StdioBridgeRequest
    assert StdioBridgeResponse
    assert process_bridge_line
    assert run_stdio_bridge
    assert StdioBridgeError


def test_parse_valid_ping_request() -> None:
    request = parse_bridge_request(bridge_request("bridge-1", "ping"))

    assert request.contract_version == CONTRACT_VERSION
    assert request.bridge_request_id == "bridge-1"
    assert request.type == "ping"
    assert request.payload == {}


def test_ping_response(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(adapter, bridge_request("bridge-1", "ping"))

    assert response["ok"] is True
    assert response["response"]["pong"] is True


def test_status_before_init(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(
        adapter,
        bridge_request("bridge-status", "handle_payload", channel_payload("status", "m1")),
    )

    assert response["ok"] is True
    assert response["response"]["ok"] is True
    assert response["response"]["event_type"] == "turn_completed"
    assert not (tmp_path / ".weaveflow").exists()


def test_init_pending_then_yes_confirms_across_bridge_lines(tmp_path: Path) -> None:
    responses = run_bridge(
        tmp_path,
        [
            bridge_request(
                "bridge-init",
                "handle_payload",
                channel_payload("init workspace", "m1"),
            ),
            bridge_request(
                "bridge-yes",
                "handle_payload",
                channel_payload("yes", "m2"),
            ),
        ],
    )

    assert responses[0]["response"]["event_type"] == "pending_confirmation"
    assert responses[1]["response"]["event_type"] == "turn_completed"
    assert (tmp_path / ".weaveflow").exists()


def test_create_task_flow_across_bridge_lines(tmp_path: Path) -> None:
    responses = run_bridge(
        tmp_path,
        [
            bridge_request(
                "bridge-init",
                "handle_payload",
                channel_payload("init workspace", "m1"),
            ),
            bridge_request(
                "bridge-init-yes",
                "handle_payload",
                channel_payload("yes", "m2"),
            ),
            bridge_request(
                "bridge-create",
                "handle_payload",
                channel_payload("create task Investigate auth bug", "m3"),
            ),
            bridge_request(
                "bridge-create-yes",
                "handle_payload",
                channel_payload("yes", "m4"),
            ),
        ],
    )

    assert responses[2]["response"]["event_type"] == "pending_confirmation"
    assert responses[3]["response"]["event_type"] == "turn_completed"
    assert (
        tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_list_tasks_and_doctor(tmp_path: Path) -> None:
    responses = run_bridge(
        tmp_path,
        [
            bridge_request(
                "bridge-init",
                "handle_payload",
                channel_payload("init workspace", "m1"),
            ),
            bridge_request(
                "bridge-init-yes",
                "handle_payload",
                channel_payload("yes", "m2"),
            ),
            bridge_request(
                "bridge-create",
                "handle_payload",
                channel_payload("create task Bridge list doctor", "m3"),
            ),
            bridge_request(
                "bridge-create-yes",
                "handle_payload",
                channel_payload("yes", "m4"),
            ),
            bridge_request(
                "bridge-list",
                "handle_payload",
                channel_payload("list tasks", "m5"),
            ),
            bridge_request(
                "bridge-doctor",
                "handle_payload",
                channel_payload("doctor", "m6"),
            ),
        ],
    )

    assert responses[4]["ok"] is True
    assert responses[4]["response"]["ok"] is True
    assert responses[5]["ok"] is True
    assert responses[5]["response"]["ok"] is True


def test_invalid_json_returns_json_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(adapter, "{not json")

    assert response["ok"] is False
    assert response["error_type"] == "InvalidBridgeJson"
    assert response["type"] == "invalid"


def test_missing_contract_version_returns_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(
        adapter,
        json.dumps(
            {
                "bridge_request_id": "bridge-1",
                "type": "ping",
                "payload": {},
            }
        ),
    )

    assert response["ok"] is False
    assert response["error_type"] == "InvalidBridgeRequest"


def test_wrong_contract_version_returns_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(
        adapter,
        bridge_request("bridge-1", "ping", contract_version="weaveflow.v2"),
    )

    assert response["ok"] is False
    assert response["error_type"] == "UnsupportedContractVersion"


def test_missing_bridge_request_id_returns_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(
        adapter,
        json.dumps(
            {
                "contract_version": CONTRACT_VERSION,
                "type": "ping",
                "payload": {},
            }
        ),
    )

    assert response["ok"] is False
    assert response["error_type"] == "InvalidBridgeRequest"


def test_unknown_request_type_returns_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(adapter, bridge_request("bridge-1", "unknown"))

    assert response["ok"] is False
    assert response["error_type"] == "UnsupportedBridgeRequestType"


def test_bad_payload_normalization_error_is_wrapped(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = parsed_response(
        adapter,
        bridge_request("bridge-bad", "handle_payload", {"messageId": "bad-1"}),
    )

    assert response["ok"] is False
    assert response["error_type"] == "OpenClawPayloadNormalizationError"
    assert response["response"]["error_type"] == "OpenClawPayloadNormalizationError"


def test_stdout_json_only_behavior(tmp_path: Path) -> None:
    responses = run_bridge(
        tmp_path,
        [
            bridge_request("bridge-ping", "ping"),
            bridge_request(
                "bridge-status",
                "handle_payload",
                channel_payload("status", "m1"),
            ),
            bridge_request("bridge-shutdown", "shutdown"),
        ],
    )

    assert [response["bridge_request_id"] for response in responses] == [
        "bridge-ping",
        "bridge-status",
        "bridge-shutdown",
    ]


def test_shutdown_exits_cleanly(tmp_path: Path) -> None:
    responses = run_bridge(
        tmp_path,
        [
            bridge_request("bridge-shutdown", "shutdown"),
            bridge_request("bridge-skipped", "ping"),
        ],
    )

    assert len(responses) == 1
    assert responses[0]["ok"] is True
    assert responses[0]["response"]["shutdown"] is True


def test_stdio_bridge_demo_runs() -> None:
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
    for term in ["ping", "status", "init", "create", "doctor", "error"]:
        assert term in output


def test_no_real_openclaw_import_dependency() -> None:
    for path in [
        ROOT / "src" / "weaveflow" / "adapters" / "stdio_bridge.py",
        DEMO_PATH,
    ]:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip().lower()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")


def test_stdio_bridge_docs_and_links() -> None:
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    gap = (ROOT / "docs" / "openclaw_integration_gap_analysis.md").read_text(
        encoding="utf-8"
    )
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )

    assert "docs/stdio_bridge_protocol.md" in readme
    assert "stdio bridge" in gap.lower()
    assert "stdio_bridge_protocol.md" in design
    for term in [
        "stdin",
        "stdout",
        "line-delimited JSON",
        "bridge_request_id",
        "handle_payload",
        "ping",
        "OpenClaw",
        "no server",
        "no network",
        "no authentication",
        "source of truth",
    ]:
        assert term in protocol
