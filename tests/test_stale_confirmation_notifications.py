import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters.local_wrapper import LocalBridgeWrapper
from projectops.adapters.wrapper_notifications import (
    create_explicit_confirmation_mismatch_notification,
    create_missing_confirmation_notification,
    create_rejected_confirmation_replay_notification,
    create_stale_confirmation_replay_notification,
    notification_from_wrapper_error,
    wrapper_notification_to_payload,
)


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "stale_confirmation_notifications.md"
DEMO_PATH = ROOT / "examples" / "stale_confirmation_notification_demo.py"


def payload(text: str, message_id: str = "m1") -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def start_wrapper(root: Path) -> LocalBridgeWrapper:
    wrapper = LocalBridgeWrapper(root)
    health = wrapper.start()
    assert health.ok is True
    return wrapper


def initialize_workspace(wrapper: LocalBridgeWrapper) -> None:
    pending = wrapper.handle_payload(payload("init workspace", "m-init"))
    assert pending.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-init-yes"))
    assert confirmed.ok is True


def create_task(wrapper: LocalBridgeWrapper, root: Path) -> None:
    pending = wrapper.handle_payload(
        payload("create task Stale notification test task", "m-create")
    )
    assert pending.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-create-yes"))
    assert confirmed.ok is True
    assert root.joinpath(".projectops", "tasks", "TASK-0001", "task_spec.yaml").exists()


def setup_workspace_and_task(tmp_path: Path) -> LocalBridgeWrapper:
    wrapper = start_wrapper(tmp_path)
    initialize_workspace(wrapper)
    create_task(wrapper, tmp_path)
    return wrapper


def verification_record(root: Path) -> Path:
    return root / ".projectops" / "tasks" / "TASK-0001" / "verification_record.yaml"


def create_pending_verify(wrapper: LocalBridgeWrapper):
    result = wrapper.handle_payload(
        payload("verify TASK-0001 passed manual check", "m-verify"),
        bridge_request_id="b-verify",
    )
    assert result.requires_explicit_confirmation is True
    return result


def test_imports() -> None:
    assert create_stale_confirmation_replay_notification
    assert create_rejected_confirmation_replay_notification
    assert create_missing_confirmation_notification
    assert create_explicit_confirmation_mismatch_notification
    assert notification_from_wrapper_error


def test_stale_replay_notification() -> None:
    notification = create_stale_confirmation_replay_notification(
        request_id="m-verify",
        bridge_request_id="b-verify",
        action="verify_task",
    )

    assert notification.notification_type == "stale_confirmation_replay"
    assert notification.level == "warning"
    assert notification.retry_safe is False
    assert notification.requires_user_repetition is True
    assert "stale" in notification.message or "already used" in notification.message
    assert "Repeat" in notification.suggested_action


def test_rejected_replay_notification() -> None:
    notification = create_rejected_confirmation_replay_notification(action="verify_task")

    assert notification.notification_type == "rejected_confirmation_replay"
    assert "rejected" in notification.message


def test_missing_confirmation_notification() -> None:
    notification = create_missing_confirmation_notification(request_id="missing")

    assert notification.notification_type == "missing_confirmation"
    assert "No pending confirmation" in notification.message


def test_mismatch_notification() -> None:
    notification = create_explicit_confirmation_mismatch_notification(
        request_id="m-verify",
        action="verify_task",
    )

    assert notification.notification_type == "explicit_confirmation_mismatch"
    assert notification.requires_user_repetition is False
    assert "exact confirmation phrase" in notification.suggested_action


def test_notification_payload_json_safety() -> None:
    notification = create_stale_confirmation_replay_notification(
        metadata={"path": Path("/tmp/example/file.txt")},
    )
    payload = wrapper_notification_to_payload(notification)

    json.dumps(payload)
    assert payload["metadata"]["path"] == "<path>"


def test_notification_from_wrapper_error_mapping() -> None:
    expected = {
        "StaleConfirmationReplay": "stale_confirmation_replay",
        "RejectedConfirmationReplay": "rejected_confirmation_replay",
        "PendingExplicitConfirmationNotFound": "missing_confirmation",
        "ExplicitConfirmationMismatch": "explicit_confirmation_mismatch",
    }

    for error_type, notification_type in expected.items():
        notification = notification_from_wrapper_error(error_type=error_type)
        assert notification is not None
        assert notification.notification_type == notification_type


def test_local_wrapper_mismatch_includes_notification_metadata(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        create_pending_verify(wrapper)

        result = wrapper.handle_explicit_confirmation("yes", bridge_request_id="b-verify")

        assert result.error_type == "ExplicitConfirmationMismatch"
        assert result.metadata["notification"]["notification_type"] == (
            "explicit_confirmation_mismatch"
        )
        assert len(wrapper.list_pending_explicit_confirmations()) == 1
        assert not verification_record(tmp_path).exists()
    finally:
        wrapper.shutdown()


def test_local_wrapper_consumed_replay_includes_notification_metadata(
    tmp_path: Path,
) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = create_pending_verify(wrapper)
        phrase = pending.metadata["confirmation_phrase"]
        first = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )
        replay = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )

        assert first.ok is True
        assert replay.error_type == "StaleConfirmationReplay"
        assert replay.metadata["notification"]["notification_type"] == (
            "stale_confirmation_replay"
        )
        assert replay.routed is False
        assert replay.bridge_response is None
    finally:
        wrapper.shutdown()


def test_local_wrapper_missing_pending_includes_notification_metadata(
    tmp_path: Path,
) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_explicit_confirmation(
            "confirm verify_task missing",
            request_id="missing",
        )

        assert result.error_type == "PendingExplicitConfirmationNotFound"
        assert result.metadata["notification"]["notification_type"] == (
            "missing_confirmation"
        )
    finally:
        wrapper.shutdown()


def test_notification_cases_do_not_route_or_execute(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = create_pending_verify(wrapper)
        phrase = pending.metadata["confirmation_phrase"]

        mismatch = wrapper.handle_explicit_confirmation(
            "confirm wrong",
            bridge_request_id="b-verify",
        )
        assert mismatch.routed is False
        assert not verification_record(tmp_path).exists()

        exact = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )
        replay = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )

        assert exact.routed is True
        assert verification_record(tmp_path).exists()
        assert replay.routed is False
        assert replay.bridge_response is None
    finally:
        wrapper.shutdown()


def test_demo_script_runs() -> None:
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
        "ExplicitConfirmationMismatch",
        "stale_confirmation_replay",
        "explicit_confirmation_mismatch",
        "suggested_action",
    ]:
        assert term in result.stdout


def test_docs_updated() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    replay_doc = (ROOT / "docs" / "confirmation_replay_protection.md").read_text(
        encoding="utf-8"
    )
    notification_doc = (ROOT / "docs" / "wrapper_notification_contract.md").read_text(
        encoding="utf-8"
    )
    flow = (ROOT / "docs" / "local_wrapper_flow.md").read_text(encoding="utf-8")
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/stale_confirmation_notifications.md" in readme
    assert "stale_confirmation_notifications.md" in replay_doc
    assert "stale_confirmation_replay" in notification_doc
    assert "stale confirmation" in flow.lower()
    assert "stale confirmation" in design.lower() or "replay notification" in design.lower()
    for term in [
        "StaleConfirmationReplay",
        "ExplicitConfirmationMismatch",
        "missing_confirmation",
        "repeat original command",
        "OpenClaw",
        "not authentication",
    ]:
        assert term in doc
