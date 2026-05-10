import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters.local_wrapper import LocalBridgeWrapper
from projectops.adapters.replay_protection import (
    CONFIRMATION_STATE_CONSUMED,
    CONFIRMATION_STATE_PENDING,
    CONFIRMATION_STATE_REJECTED,
    ConfirmationReplayCheck,
    ConfirmationReplayGuard,
    ConfirmationReplayRecord,
)
from projectops.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "confirmation_replay_protection.md"
DEMO_PATH = ROOT / "examples" / "confirmation_replay_protection_demo.py"


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
    init = wrapper.handle_payload(payload("init workspace", "m-init"))
    assert init.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-init-yes"))
    assert confirmed.ok is True


def create_task(wrapper: LocalBridgeWrapper, root: Path) -> None:
    create = wrapper.handle_payload(
        payload("create task Replay protection test task", "m-create")
    )
    assert create.route_reason == "route_to_establish_pending_confirmation"
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
    assert result.metadata["confirmation_phrase"] == "confirm verify_task m-verify"
    return result


def test_imports() -> None:
    assert ConfirmationReplayGuard
    assert ConfirmationReplayRecord
    assert ConfirmationReplayCheck


def test_make_key_prefers_bridge_request_id() -> None:
    guard = ConfirmationReplayGuard()

    key = guard.make_key(
        action="verify_task",
        request_id="m-verify",
        bridge_request_id="b-verify",
    )

    assert key == "verify_task:bridge:b-verify"
    assert "m-verify" not in key


def test_register_pending_can_execute() -> None:
    guard = ConfirmationReplayGuard()

    record = guard.register_pending(action="verify_task", request_id="m-verify")
    check = guard.check_before_execute(action="verify_task", request_id="m-verify")

    assert record.state == CONFIRMATION_STATE_PENDING
    assert check.ok is True
    assert check.can_execute is True
    assert check.replay_detected is False


def test_mark_consumed_blocks_replay() -> None:
    guard = ConfirmationReplayGuard()
    guard.register_pending(action="verify_task", bridge_request_id="b-verify")
    guard.mark_consumed(action="verify_task", bridge_request_id="b-verify")

    check = guard.check_before_execute(
        action="verify_task",
        bridge_request_id="b-verify",
    )

    assert check.ok is False
    assert check.can_execute is False
    assert check.replay_detected is True
    assert check.error_type == "StaleConfirmationReplay"


def test_mark_rejected_blocks_replay() -> None:
    guard = ConfirmationReplayGuard()
    guard.register_pending(action="verify_task", request_id="m-verify")
    guard.mark_rejected(action="verify_task", request_id="m-verify")

    check = guard.check_before_execute(action="verify_task", request_id="m-verify")

    assert check.ok is False
    assert check.replay_detected is True
    assert check.error_type == "RejectedConfirmationReplay"


def test_no_pending_returns_not_found() -> None:
    guard = ConfirmationReplayGuard()

    check = guard.check_before_execute(action="verify_task", request_id="missing")

    assert check.ok is False
    assert check.can_execute is False
    assert check.error_type == "PendingConfirmationNotFound"


def test_json_serializability() -> None:
    guard = ConfirmationReplayGuard()
    record = guard.register_pending(
        action="verify_task",
        bridge_request_id="b-verify",
        metadata={"path": Path("/tmp/example/file.txt")},
    )
    check = guard.check_before_execute(
        action="verify_task",
        bridge_request_id="b-verify",
    )

    json.dumps(to_jsonable(record))
    json.dumps(to_jsonable(check))
    assert to_jsonable(record)["metadata"]["path"] == "<path>"


def test_clear_removes_records() -> None:
    guard = ConfirmationReplayGuard()
    guard.register_pending(action="verify_task", request_id="m-verify")

    guard.clear()

    assert guard.list_records() == []


def test_wrong_explicit_phrase_does_not_consume(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        create_pending_verify(wrapper)

        result = wrapper.handle_explicit_confirmation("yes", bridge_request_id="b-verify")
        records = wrapper.list_confirmation_replay_records()

        assert result.ok is False
        assert result.error_type == "ExplicitConfirmationMismatch"
        assert len(records) == 1
        assert records[0].state == CONFIRMATION_STATE_PENDING
        assert not verification_record(tmp_path).exists()
    finally:
        wrapper.shutdown()


def test_exact_phrase_consumes_confirmation(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = create_pending_verify(wrapper)
        phrase = pending.metadata["confirmation_phrase"]

        result = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )
        records = wrapper.list_confirmation_replay_records()

        assert result.ok is True
        assert result.routed is True
        assert verification_record(tmp_path).exists()
        assert records
        assert records[0].state == CONFIRMATION_STATE_CONSUMED
    finally:
        wrapper.shutdown()


def test_replay_exact_phrase_is_blocked(tmp_path: Path) -> None:
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
        assert replay.ok is False
        assert replay.routed is False
        assert replay.blocked is True
        assert replay.error_type == "StaleConfirmationReplay"
        assert replay.metadata["replay_detected"] is True
    finally:
        wrapper.shutdown()


def test_shutdown_clears_replay_guard(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    create_pending_verify(wrapper)
    assert len(wrapper.list_confirmation_replay_records()) == 1

    wrapper.shutdown()

    assert wrapper.list_confirmation_replay_records() == []


def test_safe_mutation_normal_flow_unchanged(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        create_task(wrapper, tmp_path)
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
        "pending",
        "mismatch",
        "first exact",
        "replay exact",
        "StaleConfirmationReplay",
    ]:
        assert term in result.stdout


def test_docs_updated() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    explicit = (ROOT / "docs" / "adapter_explicit_confirmation.md").read_text(
        encoding="utf-8"
    )
    flow = (ROOT / "docs" / "local_wrapper_flow.md").read_text(encoding="utf-8")
    restart = (ROOT / "docs" / "local_wrapper_restart_session_loss.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/confirmation_replay_protection.md" in readme
    assert "confirmation_replay_protection.md" in explicit
    assert "replay protection" in flow.lower()
    assert "replay records" in restart.lower()
    for term in [
        "StaleConfirmationReplay",
        "consumed",
        "pending",
        "rejected",
        "single-use",
        "OpenClaw",
        "not authentication",
        "not persistent",
    ]:
        assert term in doc
