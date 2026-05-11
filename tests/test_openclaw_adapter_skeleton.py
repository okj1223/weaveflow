import json
from pathlib import Path

from weaveflow.adapters.openclaw import (
    OpenClawAdapter,
    OpenClawMessage,
    OpenClawResponse,
    OpenClawSessionStore,
)
from weaveflow.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]
OPENCLAW_SRC = ROOT / "src" / "weaveflow" / "adapters" / "openclaw"


def msg(
    text: str,
    message_id: str,
    *,
    channel: str = "channel-1",
    user: str = "user-1",
    thread: str | None = "thread-1",
) -> OpenClawMessage:
    return OpenClawMessage(
        channel_id=channel,
        user_id=user,
        message_id=message_id,
        text=text,
        timestamp="2026-05-09T00:00:00Z",
        thread_id=thread,
    )


def test_openclaw_adapter_imports() -> None:
    assert OpenClawMessage
    assert OpenClawResponse
    assert OpenClawSessionStore
    assert OpenClawAdapter


def test_no_real_openclaw_import_dependency() -> None:
    for path in OPENCLAW_SRC.glob("*.py"):
        lines = path.read_text(encoding="utf-8").lower().splitlines()
        for line in lines:
            stripped = line.strip()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")


def test_status_message_before_init(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = adapter.handle_message(msg("status", "m-status"))

    assert response.ok is True
    assert "status" in response.text or "Completed" in response.text
    assert response.event_type == "turn_completed"
    assert response.requires_confirmation is False
    assert not (tmp_path / ".weaveflow").exists()


def test_init_workspace_requires_confirmation(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = adapter.handle_message(msg("init workspace", "m-init"))

    assert response.event_type == "pending_confirmation"
    assert response.requires_confirmation is True
    assert not (tmp_path / ".weaveflow").exists()


def test_yes_confirms_pending_init(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    response = adapter.handle_message(msg("yes", "m-yes"))

    assert response.ok is True
    assert (tmp_path / ".weaveflow").is_dir()
    assert response.event_type == "turn_completed"


def test_no_rejects_pending_init(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    response = adapter.handle_message(msg("no", "m-no"))

    assert response.event_type == "turn_rejected"
    assert not (tmp_path / ".weaveflow").exists()


def test_yes_without_pending_returns_clean_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = adapter.handle_message(msg("yes", "m-yes"))

    assert response.ok is False
    assert response.error_type == "PendingConfirmationNotFound"
    assert "Error" in response.text or "confirmation" in response.text


def test_confirmation_isolated_by_user(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "a-init", user="user-a"))

    user_b = adapter.handle_message(msg("yes", "b-yes", user="user-b"))

    assert user_b.ok is False
    assert user_b.error_type == "PendingConfirmationNotFound"
    assert not (tmp_path / ".weaveflow").exists()

    user_a = adapter.handle_message(msg("yes", "a-yes", user="user-a"))

    assert user_a.ok is True
    assert (tmp_path / ".weaveflow").is_dir()


def test_confirmation_isolated_by_thread(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "a-init", thread="thread-a"))

    thread_b = adapter.handle_message(msg("yes", "b-yes", thread="thread-b"))

    assert thread_b.ok is False
    assert thread_b.error_type == "PendingConfirmationNotFound"
    assert not (tmp_path / ".weaveflow").exists()

    thread_a = adapter.handle_message(msg("yes", "a-yes", thread="thread-a"))

    assert thread_a.ok is True
    assert (tmp_path / ".weaveflow").is_dir()


def test_create_task_flow(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    assert adapter.handle_message(msg("yes", "m-init-yes")).ok is True

    pending = adapter.handle_message(msg("create task Investigate auth bug", "m-task"))
    assert pending.event_type == "pending_confirmation"

    response = adapter.handle_message(msg("yes", "m-task-yes"))

    assert response.event_type == "turn_completed"
    assert response.ok is True
    assert (
        tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_plan_and_brief_flow(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    adapter.handle_message(msg("yes", "m-init-yes"))
    adapter.handle_message(msg("create task Plan and brief", "m-task"))
    adapter.handle_message(msg("yes", "m-task-yes"))

    plan_pending = adapter.handle_message(msg("plan TASK-0001", "m-plan"))
    plan_response = adapter.handle_message(msg("yes", "m-plan-yes"))

    assert plan_pending.event_type == "pending_confirmation"
    assert plan_response.ok is True
    assert (tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "plan.yaml").is_file()

    brief_pending = adapter.handle_message(msg("brief TASK-0001", "m-brief"))
    brief_response = adapter.handle_message(msg("yes", "m-brief-yes"))

    assert brief_pending.event_type == "pending_confirmation"
    assert brief_response.ok is True
    assert (
        tmp_path
        / ".weaveflow"
        / "tasks"
        / "TASK-0001"
        / "worker_brief_codex.md"
    ).is_file()


def test_read_only_list_tasks_after_task_creation(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    adapter.handle_message(msg("yes", "m-init-yes"))
    adapter.handle_message(msg("create task List me", "m-task"))
    adapter.handle_message(msg("yes", "m-task-yes"))

    response = adapter.handle_message(msg("list tasks", "m-list"))

    assert response.event_type == "turn_completed"
    assert response.requires_confirmation is False
    assert "TASK-0001" in response.text or "list_tasks" in response.text


def test_doctor_after_workflow(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    adapter.handle_message(msg("init workspace", "m-init"))
    adapter.handle_message(msg("yes", "m-init-yes"))

    response = adapter.handle_message(msg("doctor", "m-doctor"))

    assert response.event_type == "turn_completed"
    assert "healthy" in response.text or "Completed" in response.text


def test_unsupported_command_returns_error(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = adapter.handle_message(msg("unknown nonsense", "m-unknown"))

    assert response.ok is False
    assert response.event_type == "turn_error"
    assert response.error_type == "UnknownIntent"


def test_openclaw_response_json_safe(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)
    response = adapter.handle_message(msg("status", "m-status"))

    json.dumps(to_jsonable(response))


def test_session_store_behavior(tmp_path: Path) -> None:
    store = OpenClawSessionStore()

    first = store.get_or_create_session("key-1", tmp_path)
    second = store.get_or_create_session("key-1", tmp_path)
    other = store.get_or_create_session("key-2", tmp_path)

    assert first is second
    assert other is not first

    store.set_latest_pending("key-1", "req-1")
    assert store.get_latest_pending("key-1") == "req-1"
    store.clear_latest_pending("key-1")
    assert store.get_latest_pending("key-1") is None


def test_openclaw_skeleton_docs() -> None:
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Current Skeleton Implementation" in design
    assert "does not import real OpenClaw" in design
    assert "does not call OpenClaw APIs" in design
    assert "docs/openclaw_adapter_design.md" in readme
    assert "OpenClaw adapter skeleton" in readme
