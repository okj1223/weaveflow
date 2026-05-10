import subprocess
import sys
from pathlib import Path

from projectops.adapters.local_wrapper import (
    SESSION_LOSS_MESSAGE,
    LocalBridgeWrapper,
)


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "local_wrapper_restart_session_loss.md"
DEMO_PATH = ROOT / "examples" / "local_wrapper_restart_session_loss_demo.py"


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
    assert wrapper.is_running() is True
    return wrapper


def initialize_workspace(wrapper: LocalBridgeWrapper) -> None:
    pending = wrapper.handle_payload(payload("init workspace", "m-init"))
    assert pending.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-init-yes"))
    assert confirmed.ok is True


def create_task(wrapper: LocalBridgeWrapper, root: Path, message_id: str = "m-create") -> None:
    pending = wrapper.handle_payload(
        payload("create task Durable restart task", message_id)
    )
    assert pending.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", f"{message_id}-yes"))
    assert confirmed.ok is True
    assert root.joinpath(".projectops", "tasks", "TASK-0001", "task_spec.yaml").exists()


def test_docs_and_imports() -> None:
    assert DOC_PATH.exists()
    assert SESSION_LOSS_MESSAGE.startswith("The ProjectOps bridge restarted.")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    local_wrapper_flow = (ROOT / "docs" / "local_wrapper_flow.md").read_text(
        encoding="utf-8"
    )
    supervision = (ROOT / "docs" / "stdio_bridge_process_supervision.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/local_wrapper_restart_session_loss.md" in readme
    assert "local_wrapper_restart_session_loss.md" in local_wrapper_flow
    assert "local_wrapper_restart_session_loss.md" in supervision
    for term in [
        "pending confirmations",
        "explicit confirmations",
        "restart",
        "session loss",
        ".projectops",
        "SQLite",
        "repeat the command",
        "OpenClaw",
        "not persistent",
    ]:
        assert term in doc


def test_normal_pending_confirmation_lost_after_restart(tmp_path: Path) -> None:
    wrapper1 = start_wrapper(tmp_path)
    initialize_workspace(wrapper1)

    pending = wrapper1.handle_payload(payload("create task Lost pending task", "m-create"))
    assert pending.routed is True
    assert pending.bridge_response is not None
    assert pending.bridge_response["response"]["event_type"] == "pending_confirmation"
    wrapper1.shutdown()

    wrapper2 = start_wrapper(tmp_path)
    try:
        result = wrapper2.handle_payload(payload("yes", "m-yes-after-restart"))

        assert result.routed is True
        assert result.ok is False
        assert result.error_type == "PendingConfirmationNotFound"
        assert not tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "task_spec.yaml",
        ).exists()
    finally:
        wrapper2.shutdown()


def test_durable_task_survives_restart(tmp_path: Path) -> None:
    wrapper1 = start_wrapper(tmp_path)
    initialize_workspace(wrapper1)
    create_task(wrapper1, tmp_path)
    wrapper1.shutdown()

    wrapper2 = start_wrapper(tmp_path)
    try:
        list_result = wrapper2.handle_payload(payload("list tasks", "m-list"))
        doctor = wrapper2.handle_payload(payload("doctor", "m-doctor"))

        assert tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "task_spec.yaml",
        ).exists()
        assert list_result.ok is True
        assert doctor.ok is True
    finally:
        wrapper2.shutdown()


def test_explicit_confirmation_lost_after_restart(tmp_path: Path) -> None:
    wrapper1 = start_wrapper(tmp_path)
    initialize_workspace(wrapper1)
    create_task(wrapper1, tmp_path)

    pending = wrapper1.handle_payload(
        payload("verify TASK-0001 passed manual check", "m-verify"),
        bridge_request_id="b-verify",
    )
    assert pending.requires_explicit_confirmation is True
    phrase = pending.metadata["confirmation_phrase"]
    wrapper1.shutdown()

    wrapper2 = start_wrapper(tmp_path)
    try:
        result = wrapper2.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )

        assert result.ok is False
        assert result.error_type == "PendingExplicitConfirmationNotFound"
        assert not tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "verification_record.yaml",
        ).exists()
    finally:
        wrapper2.shutdown()


def test_read_only_commands_work_after_restart(tmp_path: Path) -> None:
    wrapper1 = start_wrapper(tmp_path)
    initialize_workspace(wrapper1)
    create_task(wrapper1, tmp_path)
    wrapper1.shutdown()

    wrapper2 = start_wrapper(tmp_path)
    try:
        for text, message_id in [
            ("status", "m-status"),
            ("list tasks", "m-list"),
            ("doctor", "m-doctor"),
        ]:
            result = wrapper2.handle_payload(payload(text, message_id))
            assert result.routed is True
            assert result.ok is True
    finally:
        wrapper2.shutdown()


def test_restart_does_not_corrupt_workspace(tmp_path: Path) -> None:
    wrapper1 = start_wrapper(tmp_path)
    initialize_workspace(wrapper1)
    create_task(wrapper1, tmp_path)
    wrapper1.shutdown()

    wrapper2 = start_wrapper(tmp_path)
    try:
        doctor = wrapper2.handle_payload(payload("doctor", "m-doctor"))
        assert doctor.ok is True
        assert doctor.bridge_response is not None
        assert doctor.bridge_response["response"]["ok"] is True
    finally:
        wrapper2.shutdown()


def test_local_wrapper_restart_session_loss_demo_runs() -> None:
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
        "pending create",
        "after restart",
        "PendingConfirmationNotFound",
        "pending explicit",
        "PendingExplicitConfirmationNotFound",
        "durable task",
        "doctor",
    ]:
        assert term in result.stdout
