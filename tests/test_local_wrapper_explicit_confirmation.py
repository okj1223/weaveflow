import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters.local_wrapper import (
    LocalBridgeWrapper,
    PendingExplicitConfirmation,
)
from projectops.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "local_wrapper_explicit_confirmation_demo.py"


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
        payload("create task Explicit confirmation test task", "m-create")
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


def test_imports() -> None:
    assert LocalBridgeWrapper
    assert PendingExplicitConfirmation


def test_sensitive_action_creates_pending_explicit_confirmation(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        result = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )

        assert result.ok is True
        assert result.routed is False
        assert result.requires_explicit_confirmation is True
        assert result.route_reason == "explicit_confirmation_required"
        assert result.metadata["confirmation_phrase"] == "confirm verify_task m-verify"
        assert len(wrapper.list_pending_explicit_confirmations()) == 1
        assert not verification_record(tmp_path).exists()
    finally:
        wrapper.shutdown()


def test_plain_yes_does_not_execute_sensitive_action(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        assert pending.route_reason == "explicit_confirmation_required"

        yes_result = wrapper.handle_payload(payload("yes", "m-yes"))
        assert yes_result.routed is True
        assert yes_result.error_type == "PendingConfirmationNotFound"
        assert not verification_record(tmp_path).exists()

        mismatch = wrapper.handle_explicit_confirmation("yes", bridge_request_id="b-verify")
        assert mismatch.ok is False
        assert mismatch.error_type == "ExplicitConfirmationMismatch"
        assert len(wrapper.list_pending_explicit_confirmations()) == 1
    finally:
        wrapper.shutdown()


def test_wrong_explicit_phrase_keeps_pending(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        result = wrapper.handle_explicit_confirmation(
            "confirm wrong",
            bridge_request_id="b-verify",
        )

        assert result.ok is False
        assert result.routed is False
        assert result.error_type == "ExplicitConfirmationMismatch"
        assert len(wrapper.list_pending_explicit_confirmations()) == 1
    finally:
        wrapper.shutdown()


def test_exact_explicit_phrase_routes_original_payload(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        phrase = pending.metadata["confirmation_phrase"]

        result = wrapper.handle_explicit_confirmation(phrase, bridge_request_id="b-verify")

        assert result.ok is True
        assert result.routed is True
        assert result.route_reason == "explicit_confirmation_matched"
        assert result.bridge_response is not None
        assert result.bridge_response["response"]["event_type"] == "turn_completed"
        assert verification_record(tmp_path).exists()
        assert wrapper.list_pending_explicit_confirmations() == []
    finally:
        wrapper.shutdown()


def test_missing_pending_explicit_confirmation(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_explicit_confirmation(
            "confirm verify_task missing",
            request_id="missing",
        )

        assert result.ok is False
        assert result.blocked is True
        assert result.error_type == "PendingExplicitConfirmationNotFound"
    finally:
        wrapper.shutdown()


def test_bridge_request_id_and_request_id_lookup(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        first = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify-a"),
            bridge_request_id="b-verify-a",
        )
        first_result = wrapper.handle_explicit_confirmation(
            first.metadata["confirmation_phrase"],
            bridge_request_id="b-verify-a",
        )
        assert first_result.ok is True

        second = wrapper.handle_payload(
            payload("verify TASK-0001 passed second check", "m-verify-b")
        )
        second_result = wrapper.handle_explicit_confirmation(
            second.metadata["confirmation_phrase"],
            request_id="m-verify-b",
        )
        assert second_result.ok is True
        assert wrapper.list_pending_explicit_confirmations() == []
    finally:
        wrapper.shutdown()


def test_sensitive_create_final_report_held(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        result = wrapper.handle_payload(payload("report TASK-0001", "m-report"))

        assert result.routed is False
        assert result.requires_explicit_confirmation is True
        assert result.action == "create_final_report"
        assert not tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "final_report.md",
        ).exists()
    finally:
        wrapper.shutdown()


def test_attach_result_held_before_routing(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    result_path = tmp_path / "result.md"
    result_path.write_text("local result", encoding="utf-8")
    try:
        result = wrapper.handle_payload(
            payload(f"attach result TASK-0001 {result_path}", "m-attach")
        )

        assert result.routed is False
        assert result.requires_explicit_confirmation is True
        assert result.action == "attach_result"
        assert not tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "artifacts.yaml",
        ).exists()
    finally:
        wrapper.shutdown()


def test_shutdown_clears_pending_explicit_confirmations(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    wrapper.handle_payload(
        payload("verify TASK-0001 passed manual check", "m-verify"),
        bridge_request_id="b-verify",
    )
    assert len(wrapper.list_pending_explicit_confirmations()) == 1

    wrapper.shutdown()

    assert wrapper.list_pending_explicit_confirmations() == []


def test_bridge_not_started_for_explicit_confirmation() -> None:
    wrapper = LocalBridgeWrapper(Path("/tmp/projectops-wrapper-not-started"))
    result = wrapper.handle_explicit_confirmation(
        "confirm verify_task m-verify",
        request_id="m-verify",
    )

    assert result.routed is False
    assert result.blocked is True
    assert result.error_type == "BridgeNotRunning"


def test_json_serializability(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        result = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        pending = wrapper.list_pending_explicit_confirmations()[0]

        json.dumps(to_jsonable(result))
        json.dumps(to_jsonable(pending))
    finally:
        wrapper.shutdown()


def test_local_wrapper_explicit_confirmation_demo_runs() -> None:
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
        "explicit_confirmation_required",
        "confirmation phrase",
        "yes",
        "mismatch",
        "routed",
        "verify_task",
    ]:
        assert term in result.stdout


def test_docs_updated_for_local_wrapper_explicit_confirmation() -> None:
    local_wrapper_doc = (ROOT / "docs" / "local_wrapper_flow.md").read_text(
        encoding="utf-8"
    )
    explicit_doc = (ROOT / "docs" / "adapter_explicit_confirmation.md").read_text(
        encoding="utf-8"
    )
    openclaw_doc = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "explicit confirmation flow" in local_wrapper_doc.lower()
    assert "LocalBridgeWrapper" in explicit_doc
    assert "exact phrase" in openclaw_doc or "explicit confirmation" in openclaw_doc
    assert (
        "adapter_explicit_confirmation" in readme
        or "local wrapper explicit" in readme.lower()
    )


def test_runtime_compatibility_safe_mutation_still_works(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        create_task(wrapper, tmp_path)
        assert tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "task_spec.yaml",
        ).exists()
    finally:
        wrapper.shutdown()
