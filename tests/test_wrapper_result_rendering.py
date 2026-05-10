import json
import subprocess
import sys
from pathlib import Path

import pytest

from projectops.adapters.local_wrapper import LocalBridgeWrapper, WrapperRouteResult
from projectops.adapters.wrapper_notifications import create_session_loss_notification
from projectops.adapters.wrapper_rendering import (
    render_wrapper_notification_for_channel,
    render_wrapper_result_as_text,
    render_wrapper_result_payload,
    render_wrapper_result_summary,
)


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "wrapper_result_rendering.md"
DEMO_PATH = ROOT / "examples" / "wrapper_result_rendering_demo.py"


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
        payload("create task Wrapper rendering test task", "m-create")
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


def test_imports() -> None:
    assert render_wrapper_result_as_text
    assert render_wrapper_notification_for_channel
    assert render_wrapper_result_summary


def test_status_routed_render(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(payload("status", "m-status"))
        rendered = render_wrapper_result_as_text(result)

        assert "Routed" in rendered or "Completed" in rendered
        assert "status" in rendered
    finally:
        wrapper.shutdown()


def test_create_task_pending_render(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        result = wrapper.handle_payload(
            payload("create task Render pending task", "m-create")
        )
        rendered = render_wrapper_result_as_text(result)

        assert "pending_confirmation" in rendered or "confirmation" in rendered
        assert "completed" not in rendered.lower()
        assert not tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "task_spec.yaml",
        ).exists()
    finally:
        wrapper.shutdown()


def test_yes_confirmation_render(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        wrapper.handle_payload(payload("create task Confirmed render task", "m-create"))
        result = wrapper.handle_payload(payload("yes", "m-yes"))
        rendered = render_wrapper_result_as_text(result)

        assert "Routed" in rendered or "completed" in rendered.lower()
        assert tmp_path.joinpath(
            ".projectops",
            "tasks",
            "TASK-0001",
            "task_spec.yaml",
        ).exists()
    finally:
        wrapper.shutdown()


def test_explicit_confirmation_required_render(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        result = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        rendered = render_wrapper_result_as_text(result)

        assert result.routed is False
        assert "Explicit confirmation" in rendered
        assert "confirm verify_task m-verify" in rendered
    finally:
        wrapper.shutdown()


def test_mismatch_notification_render(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        result = wrapper.handle_explicit_confirmation("yes", bridge_request_id="b-verify")
        rendered = render_wrapper_result_as_text(result)

        assert result.metadata["notification"]["notification_type"] == (
            "explicit_confirmation_mismatch"
        )
        assert "mismatch" in rendered.lower() or "exact confirmation phrase" in rendered
    finally:
        wrapper.shutdown()


def test_stale_replay_notification_render(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        pending = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        phrase = pending.metadata["confirmation_phrase"]
        wrapper.handle_explicit_confirmation(phrase, bridge_request_id="b-verify")
        replay = wrapper.handle_explicit_confirmation(phrase, bridge_request_id="b-verify")
        rendered = render_wrapper_result_as_text(replay)

        assert "stale" in rendered.lower() or "already used" in rendered.lower()
    finally:
        wrapper.shutdown()


def test_high_risk_blocked_render(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(payload("auto run codex", "m-risk"))
        rendered = render_wrapper_result_as_text(result)

        assert "Blocked" in rendered
        assert "future high-risk" in rendered
    finally:
        wrapper.shutdown()


def test_bad_payload_render(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload({"content": "status"})
        rendered = render_wrapper_result_as_text(result)

        assert "Error" in rendered
        assert "OpenClawPayloadNormalizationError" in rendered
    finally:
        wrapper.shutdown()


def test_notification_render_openclaw() -> None:
    notification = create_session_loss_notification(request_id="m-1")

    rendered = render_wrapper_notification_for_channel(notification, channel="openclaw")

    assert notification.suggested_action in rendered
    assert "session_loss" in rendered


def test_notification_render_log() -> None:
    notification = create_session_loss_notification(request_id="m-1")

    rendered = render_wrapper_notification_for_channel(notification, channel="log")

    assert "\n" not in rendered
    assert "type=session_loss" in rendered


def test_unknown_channel_raises(tmp_path: Path) -> None:
    result = WrapperRouteResult(
        ok=True,
        routed=False,
        blocked=False,
        route_reason="test",
        requires_confirmation=False,
        requires_explicit_confirmation=False,
        summary="test result",
    )
    notification = create_session_loss_notification()

    with pytest.raises(ValueError):
        render_wrapper_result_as_text(result, channel="unknown")
    with pytest.raises(ValueError):
        render_wrapper_notification_for_channel(notification, channel="unknown")


def test_summary_render() -> None:
    result = WrapperRouteResult(
        ok=False,
        routed=False,
        blocked=True,
        route_reason="blocked_by_preflight",
        action="auto_run_codex",
        category="future_high_risk",
        requires_confirmation=False,
        requires_explicit_confirmation=True,
        error_type="FutureHighRisk",
        summary="blocked",
    )

    rendered = render_wrapper_result_summary(result)

    assert "\n" not in rendered
    assert "routed=false" in rendered
    assert "blocked=true" in rendered
    assert "action=auto_run_codex" in rendered


def test_render_wrapper_result_payload_json_safe() -> None:
    result = WrapperRouteResult(
        ok=True,
        routed=False,
        blocked=False,
        route_reason="test",
        requires_confirmation=False,
        requires_explicit_confirmation=False,
        summary="test",
        metadata={"path": Path("/tmp/example/file.txt")},
    )

    payload = render_wrapper_result_payload(result)

    json.dumps(payload)
    assert isinstance(payload, dict)


def test_renderer_does_not_touch_files(tmp_path: Path) -> None:
    result = WrapperRouteResult(
        ok=True,
        routed=False,
        blocked=False,
        route_reason="test",
        requires_confirmation=False,
        requires_explicit_confirmation=False,
        summary="render only",
    )

    render_wrapper_result_as_text(result)

    assert not tmp_path.joinpath(".projectops").exists()


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
        "status",
        "create task",
        "confirmation",
        "explicit",
        "mismatch",
        "auto_run_codex",
        "bad payload",
        "log",
    ]:
        assert term in result.stdout


def test_docs_updated() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    flow = (ROOT / "docs" / "local_wrapper_flow.md").read_text(encoding="utf-8")
    notification_doc = (ROOT / "docs" / "wrapper_notification_contract.md").read_text(
        encoding="utf-8"
    )
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/wrapper_result_rendering.md" in readme
    assert "wrapper_result_rendering.md" in flow
    assert "wrapper_result_rendering.md" in notification_doc
    assert "wrapper result rendering" in design.lower()
    for term in [
        "WrapperRouteResult",
        "WrapperNotification",
        "render_wrapper_result_as_text",
        "OpenClaw",
        "source of truth",
        "not execution",
        "not authentication",
    ]:
        assert term in doc
