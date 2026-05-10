import json
import subprocess
import sys
from pathlib import Path

import pytest

from projectops.adapters.local_wrapper import LocalBridgeWrapper
from projectops.adapters.wrapper_notifications import (
    SESSION_LOSS_NOTIFICATION_TYPE,
    WrapperNotification,
    create_session_loss_notification,
    is_retry_safe_after_session_loss,
    wrapper_notification_to_payload,
    wrapper_notification_to_text,
)
from projectops.json_io import CONTRACT_VERSION


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "wrapper_notification_contract.md"
DEMO_PATH = ROOT / "examples" / "wrapper_notification_demo.py"


def test_imports() -> None:
    assert WrapperNotification
    assert create_session_loss_notification
    assert wrapper_notification_to_text
    assert wrapper_notification_to_payload
    assert is_retry_safe_after_session_loss


def test_create_session_loss_notification() -> None:
    notification = create_session_loss_notification()

    assert notification.contract_version == CONTRACT_VERSION
    assert notification.notification_type == SESSION_LOSS_NOTIFICATION_TYPE
    assert notification.level == "warning"
    assert notification.pending_cleared is True
    assert notification.requires_user_repetition is True
    assert "Pending confirmations were cleared" in notification.message


def test_preserves_ids() -> None:
    notification = create_session_loss_notification(
        request_id="m-1",
        bridge_request_id="b-1",
        session_key="channel:user:thread",
        action="create_task",
    )

    assert notification.request_id == "m-1"
    assert notification.bridge_request_id == "b-1"
    assert notification.session_key == "channel:user:thread"
    assert notification.action == "create_task"


def test_retry_safe_read_only_actions() -> None:
    for action in ["status", "list_tasks", "doctor", "show_task"]:
        assert is_retry_safe_after_session_loss(action) is True

    notification = create_session_loss_notification(
        action="status",
        retry_safe=is_retry_safe_after_session_loss("status"),
    )
    assert notification.retry_safe is True


def test_retry_unsafe_mutating_actions() -> None:
    for action in ["create_task", "verify_task", "create_final_report"]:
        assert is_retry_safe_after_session_loss(action) is False


def test_future_high_risk_never_retry_safe() -> None:
    for action in ["auto_run_codex", "deploy"]:
        assert is_retry_safe_after_session_loss(action) is False


def test_chat_rendering() -> None:
    notification = create_session_loss_notification(
        request_id="m-1",
        action="create_task",
    )
    text = wrapper_notification_to_text(notification, style="chat")

    assert isinstance(text, str)
    assert notification.message in text
    assert notification.suggested_action in text
    assert "m-1" in text


def test_log_rendering() -> None:
    notification = create_session_loss_notification(
        request_id="m-1",
        bridge_request_id="b-1",
    )
    text = wrapper_notification_to_text(notification, style="log")

    assert isinstance(text, str)
    assert "\n" not in text
    assert "type=session_loss" in text
    assert "level=warning" in text


def test_unknown_style_raises() -> None:
    notification = create_session_loss_notification()

    with pytest.raises(ValueError):
        wrapper_notification_to_text(notification, style="bad")


def test_payload_json_safety() -> None:
    notification = create_session_loss_notification()
    payload = wrapper_notification_to_payload(notification)

    assert isinstance(payload, dict)
    json.dumps(payload)
    assert payload["notification_type"] == "session_loss"


def test_metadata_json_safety(tmp_path: Path) -> None:
    class OddValue:
        def __str__(self) -> str:
            return "odd-value"

    path = tmp_path / "secret" / "file.txt"
    notification = create_session_loss_notification(
        metadata={"path": path, "odd": OddValue()}
    )
    payload = wrapper_notification_to_payload(notification)

    json.dumps(payload)
    assert not isinstance(payload["metadata"]["path"], Path)
    assert payload["metadata"]["odd"] == "odd-value"


def test_local_bridge_wrapper_compatibility(tmp_path: Path) -> None:
    wrapper = LocalBridgeWrapper(tmp_path)
    notification = wrapper.create_session_loss_notification(
        request_id="m-1",
        action="status",
        retry_safe=is_retry_safe_after_session_loss("status"),
    )

    assert notification.message == wrapper.session_loss_message()
    assert notification.retry_safe is True


def test_wrapper_notification_demo_runs() -> None:
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
        "session_loss",
        "chat",
        "log",
        "retry_safe",
        "repeat the command",
    ]:
        assert term in result.stdout


def test_docs_updated_for_wrapper_notifications() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    restart_doc = (ROOT / "docs" / "local_wrapper_restart_session_loss.md").read_text(
        encoding="utf-8"
    )
    supervision = (ROOT / "docs" / "stdio_bridge_process_supervision.md").read_text(
        encoding="utf-8"
    )
    openclaw = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/wrapper_notification_contract.md" in readme
    assert "wrapper_notification_contract.md" in restart_doc
    assert "wrapper notification" in supervision.lower()
    assert "WrapperNotification" in openclaw or "notification contract" in openclaw
    for term in [
        "WrapperNotification",
        "session loss",
        "pending confirmations",
        "repeat the command",
        "OpenClaw",
        "not persistent",
        "not authentication",
    ]:
        assert term in doc
