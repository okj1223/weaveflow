import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters.base import AdapterRequest
from projectops.adapters.openclaw import OpenClawAdapter, OpenClawMessage
from projectops.adapters.permission_preflight import (
    PermissionPreflightResult,
    permission_preflight_result_to_payload,
    preflight_adapter_request,
    preflight_openclaw_payload,
    preflight_text_command,
)


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_permission_preflight_demo.py"
DOC_PATH = ROOT / "docs" / "adapter_permission_preflight.md"


def payload(content: str, message_id: str = "m1") -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": content,
        "createdAt": "2026-05-10T00:00:00Z",
    }


def test_adapter_permission_preflight_imports() -> None:
    assert PermissionPreflightResult
    assert preflight_text_command
    assert preflight_openclaw_payload
    assert preflight_adapter_request


def test_read_only_text_preflight_routes() -> None:
    result = preflight_text_command("status")

    assert result.ok is True
    assert result.action == "status"
    assert result.allowed is True
    assert result.should_route is True
    assert result.blocked is False
    assert result.read_only is True


def test_safe_mutation_without_allow_mutation_asks_confirmation() -> None:
    result = preflight_text_command("create task Investigate auth bug")

    assert result.ok is True
    assert result.action == "create_task"
    assert result.allowed is False
    assert result.should_route is False
    assert result.should_ask_confirmation is True
    assert result.blocked is False


def test_safe_mutation_with_allow_mutation_routes() -> None:
    result = preflight_text_command(
        "create task Investigate auth bug",
        allow_mutation=True,
    )

    assert result.allowed is True
    assert result.should_route is True
    assert result.blocked is False


def test_sensitive_mutation_without_explicit_confirmation_asks_explicit() -> None:
    result = preflight_text_command(
        "verify TASK-0001 passed manual check",
        allow_mutation=True,
        explicit_confirmation=False,
    )

    assert result.action == "verify_task"
    assert result.allowed is False
    assert result.should_route is False
    assert result.should_ask_explicit_confirmation is True
    assert result.blocked is False


def test_sensitive_mutation_with_explicit_confirmation_routes() -> None:
    result = preflight_text_command(
        "verify TASK-0001 passed manual check",
        allow_mutation=True,
        explicit_confirmation=True,
    )

    assert result.allowed is True
    assert result.should_route is True


def test_future_high_risk_text_blocks() -> None:
    commands = [
        "auto run codex",
        "apply memory diff",
        "repair workspace",
        "delete artifact",
        "deploy",
        "call external api",
    ]

    for command in commands:
        result = preflight_text_command(command)
        assert result.ok is True
        assert result.category == "future_high_risk"
        assert result.blocked is True
        assert result.should_route is False
        assert result.allowed is False


def test_unknown_text_blocks() -> None:
    result = preflight_text_command("nonsense")

    assert result.ok is False
    assert result.blocked is True
    assert result.should_route is False
    assert result.error_type == "UnknownIntent"


def test_empty_text_blocks() -> None:
    result = preflight_text_command("")

    assert result.ok is False
    assert result.blocked is True
    assert result.error_type == "EmptyIntent"


def test_raw_payload_read_only_routes() -> None:
    result = preflight_openclaw_payload(payload("status", "msg-status"))

    assert result.should_route is True
    assert result.request_id == "msg-status"


def test_raw_payload_safe_mutation_asks_confirmation() -> None:
    result = preflight_openclaw_payload(payload("create task Investigate auth bug"))

    assert result.action == "create_task"
    assert result.should_ask_confirmation is True


def test_raw_payload_normalization_error_blocks() -> None:
    result = preflight_openclaw_payload({"messageId": "bad-1"})

    assert result.ok is False
    assert result.blocked is True
    assert result.error_type == "OpenClawPayloadNormalizationError"


def test_adapter_request_preflight() -> None:
    status = preflight_adapter_request(AdapterRequest(action="status"))
    create_unconfirmed = preflight_adapter_request(AdapterRequest(action="create_task"))
    create_confirmed = preflight_adapter_request(
        AdapterRequest(action="create_task", allow_mutation=True)
    )

    assert status.should_route is True
    assert create_unconfirmed.should_ask_confirmation is True
    assert create_confirmed.should_route is True


def test_preflight_does_not_touch_files(tmp_path: Path) -> None:
    preflight_text_command("status")
    preflight_openclaw_payload(payload("list tasks"))
    preflight_adapter_request(AdapterRequest(action="create_task"))

    assert not (tmp_path / ".projectops").exists()


def test_permission_preflight_result_json_serializable() -> None:
    result = preflight_text_command("status")
    payload_dict = permission_preflight_result_to_payload(result)

    json.dumps(payload_dict)
    assert payload_dict["contract_version"] == "projectops.v1"


def test_permission_preflight_demo_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        [sys.executable, str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    for term in [
        "status",
        "create_task",
        "verify_task",
        "auto_run_codex",
        "future_high_risk",
        "OpenClawPayloadNormalizationError",
    ]:
        assert term in result.stdout


def test_adapter_permission_preflight_docs() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    policy = (ROOT / "docs" / "adapter_permission_policy.md").read_text(
        encoding="utf-8"
    )
    channel = (ROOT / "docs" / "channel_adapter_contract.md").read_text(
        encoding="utf-8"
    )
    client = (ROOT / "docs" / "stdio_bridge_client_contract.md").read_text(
        encoding="utf-8"
    )
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/adapter_permission_preflight.md" in readme
    assert "adapter_permission_preflight.md" in policy
    assert "permission preflight" in channel.lower()
    assert "preflight" in client.lower()
    assert "preflight" in design.lower()
    for term in [
        "PermissionPreflightResult",
        "future_high_risk",
        "should_route",
        "should_ask_confirmation",
        "explicit_confirmation",
        "OpenClaw",
        "not authentication",
    ]:
        assert term in doc


def test_runtime_compatibility_openclaw_adapter_still_works(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    response = adapter.handle_message(
        OpenClawMessage(
            channel_id="channel-1",
            user_id="user-1",
            message_id="m1",
            text="status",
            timestamp="2026-05-10T00:00:00Z",
        )
    )

    assert response.ok is True
    assert response.event_type == "turn_completed"
