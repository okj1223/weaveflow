import subprocess
import sys
from pathlib import Path

from weaveflow.adapters.local_wrapper import LocalBridgeWrapper, WrapperRouteResult


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "local_wrapper_flow_demo.py"
DOC_PATH = ROOT / "docs" / "local_wrapper_flow.md"


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
    init = wrapper.handle_payload(payload("init workspace", "m-init"))
    assert init.routed is True
    assert init.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-init-yes"))
    assert confirmed.routed is True
    assert confirmed.ok is True


def create_task(wrapper: LocalBridgeWrapper, root: Path) -> None:
    create = wrapper.handle_payload(payload("create task Investigate auth bug", "m-create"))
    assert create.routed is True
    assert create.route_reason == "route_to_establish_pending_confirmation"
    assert not root.joinpath(".weaveflow", "tasks", "TASK-0001").exists()
    confirmed = wrapper.handle_payload(payload("yes", "m-create-yes"))
    assert confirmed.routed is True
    assert confirmed.ok is True
    assert root.joinpath(".weaveflow", "tasks", "TASK-0001", "task_spec.yaml").exists()


def test_local_wrapper_imports() -> None:
    assert LocalBridgeWrapper
    assert WrapperRouteResult


def test_start_health_check(tmp_path: Path) -> None:
    wrapper = LocalBridgeWrapper(tmp_path)
    try:
        health = wrapper.start()
        assert health.ok is True
        assert health.pong is True
        assert wrapper.is_running() is True
    finally:
        wrapper.shutdown()


def test_status_routes(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(payload("status", "m-status"))
        assert result.routed is True
        assert result.blocked is False
        assert result.action == "status"
        assert result.bridge_response is not None
        assert result.bridge_response["ok"] is True
    finally:
        wrapper.shutdown()


def test_safe_mutation_routes_to_establish_pending_confirmation(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        result = wrapper.handle_payload(payload("create task Investigate auth bug", "m-create"))
        assert result.routed is True
        assert result.route_reason == "route_to_establish_pending_confirmation"
        assert result.bridge_response is not None
        assert result.bridge_response["response"]["event_type"] == "pending_confirmation"
        assert not tmp_path.joinpath(".weaveflow", "tasks", "TASK-0001").exists()
    finally:
        wrapper.shutdown()


def test_yes_confirms_pending_safe_mutation(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        pending = wrapper.handle_payload(payload("create task Investigate auth bug", "m-create"))
        assert pending.routed is True
        result = wrapper.handle_payload(payload("yes", "m-create-yes"))
        assert result.routed is True
        assert result.bridge_response is not None
        assert result.bridge_response["response"]["event_type"] == "turn_completed"
        assert tmp_path.joinpath(".weaveflow", "tasks", "TASK-0001", "task_spec.yaml").exists()
    finally:
        wrapper.shutdown()


def test_list_tasks_routes_after_task_creation(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        initialize_workspace(wrapper)
        create_task(wrapper, tmp_path)
        result = wrapper.handle_payload(payload("list tasks", "m-list"))
        assert result.routed is True
        assert result.blocked is False
        assert result.bridge_response is not None
        assert result.bridge_response["response"]["event_type"] == "turn_completed"
    finally:
        wrapper.shutdown()


def test_sensitive_mutation_without_explicit_confirmation_does_not_route(
    tmp_path: Path,
) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify")
        )
        assert result.routed is False
        assert result.blocked is False
        assert result.requires_explicit_confirmation is True
        assert result.bridge_response is None
    finally:
        wrapper.shutdown()


def test_future_high_risk_blocks(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(payload("auto run codex", "m-codex"))
        assert result.routed is False
        assert result.blocked is True
        assert result.category == "future_high_risk"
    finally:
        wrapper.shutdown()


def test_bad_payload_blocks(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload({"messageId": "bad-1"})
        assert result.routed is False
        assert result.blocked is True
        assert result.error_type == "OpenClawPayloadNormalizationError"
    finally:
        wrapper.shutdown()


def test_confirmation_response_routes_directly(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        result = wrapper.handle_payload(payload("yes", "m-yes"))
        assert result.routed is True
        assert result.route_reason == "confirmation_response"
        assert result.bridge_response is not None
        assert result.bridge_response["error_type"] == "PendingConfirmationNotFound"
    finally:
        wrapper.shutdown()


def test_bridge_not_started_blocks() -> None:
    wrapper = LocalBridgeWrapper(Path("/tmp/weaveflow-wrapper-not-started"))
    result = wrapper.handle_payload(payload("status", "m-status"))
    assert result.routed is False
    assert result.blocked is True
    assert result.error_type == "BridgeNotRunning"


def test_shutdown_behavior(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    result = wrapper.shutdown()
    assert result is not None
    assert result.ok is True
    assert wrapper.is_running() is False
    assert wrapper.shutdown() is None


def test_no_real_openclaw_import_dependency() -> None:
    for path in [
        ROOT / "src" / "weaveflow" / "adapters" / "local_wrapper.py",
        DEMO_PATH,
    ]:
        source = path.read_text(encoding="utf-8").lower()
        assert "import openclaw" not in source
        assert "from openclaw" not in source


def test_local_wrapper_flow_demo_runs() -> None:
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
        "health",
        "status",
        "create task",
        "yes",
        "list tasks",
        "verify",
        "auto run codex",
        "bad payload",
        "shutdown",
    ]:
        assert term in result.stdout


def test_local_wrapper_flow_docs() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    preflight = (ROOT / "docs" / "adapter_permission_preflight.md").read_text(
        encoding="utf-8"
    )
    health = (ROOT / "docs" / "stdio_bridge_health_checks.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/local_wrapper_flow.md" in readme
    assert "LocalBridgeWrapper" in preflight or "local wrapper" in preflight.lower()
    assert "LocalBridgeWrapper" in health or "local wrapper" in health.lower()
    for term in [
        "health check",
        "permission preflight",
        "stdio bridge",
        "route_to_establish_pending_confirmation",
        "sensitive mutation",
        "future high-risk",
        "OpenClaw",
        "not a server",
        "not authentication",
    ]:
        assert term in doc
