import json
import subprocess
from pathlib import Path

from projectops.adapters import AdapterSession, AdapterTurnResult, ProjectOpsServiceAdapter
from projectops.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_session_demo.py"


def make_session(root: Path) -> AdapterSession:
    return AdapterSession(ProjectOpsServiceAdapter(root))


def confirm_text(session: AdapterSession, text: str, request_id: str) -> AdapterTurnResult:
    pending = session.handle_text(text, request_id=request_id)
    assert pending.state == "pending_confirmation"
    return session.confirm(request_id)


def test_adapter_session_imports() -> None:
    session_cls = AdapterSession
    result_cls = AdapterTurnResult

    assert session_cls
    assert result_cls


def test_status_executes_immediately(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("status")

    assert result.state == "completed"
    assert result.ok is True
    assert result.pending is False
    assert result.response is not None
    assert result.response.data is not None
    assert result.response.data["workspace_exists"] is False


def test_mutating_init_becomes_pending(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("init workspace", request_id="req-init")

    assert result.state == "pending_confirmation"
    assert result.pending is True
    assert not (tmp_path / ".projectops").exists()
    assert session.has_pending("req-init") is True
    assert session.list_pending() == ["req-init"]


def test_confirm_init_executes(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    session.handle_text("init workspace", request_id="req-init")
    result = session.confirm("req-init")

    assert result.state == "completed"
    assert result.ok is True
    assert (tmp_path / ".projectops").is_dir()
    assert session.has_pending("req-init") is False


def test_reject_init_does_not_execute(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    session.handle_text("init workspace", request_id="req-init")
    result = session.reject("req-init")

    assert result.state == "rejected"
    assert result.ok is True
    assert not (tmp_path / ".projectops").exists()
    assert session.has_pending("req-init") is False


def test_confirm_missing_request_id_returns_error(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.confirm("missing")

    assert result.state == "error"
    assert result.ok is False
    assert result.error_type == "PendingConfirmationNotFound"


def test_reject_missing_request_id_returns_error(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.reject("missing")

    assert result.state == "error"
    assert result.ok is False
    assert result.error_type == "PendingConfirmationNotFound"


def test_create_task_confirmation_flow(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    assert confirm_text(session, "init workspace", "req-init").ok is True

    pending = session.handle_text(
        "create task Investigate auth bug",
        request_id="req-task",
    )
    assert pending.state == "pending_confirmation"

    result = session.confirm("req-task")

    assert result.ok is True
    assert result.response is not None
    assert result.response.data is not None
    assert result.response.data["id"] == "TASK-0001"
    assert (
        tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_read_only_after_workspace_init(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    assert confirm_text(session, "init workspace", "req-init").ok is True

    result = session.handle_text("list tasks", request_id="req-list")

    assert result.state == "completed"
    assert result.ok is True
    assert result.pending is False
    assert result.response is not None
    assert result.response.read_only is True
    assert result.response.data is not None
    assert result.response.data["count"] == 0


def test_full_session_flow(tmp_path: Path) -> None:
    session = make_session(tmp_path)

    assert confirm_text(session, "init workspace", "req-init").ok is True
    assert confirm_text(session, "create task Full session task", "req-task").ok is True
    assert confirm_text(session, "plan TASK-0001", "req-plan").ok is True
    assert confirm_text(session, "brief TASK-0001", "req-brief").ok is True

    doctor = session.handle_text("doctor", request_id="req-doctor")

    assert doctor.state == "completed"
    assert doctor.ok is True
    assert doctor.response is not None
    assert doctor.response.data is not None
    assert doctor.response.data["healthy"] is True


def test_allow_mutation_true_executes_immediately(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("init workspace", allow_mutation=True)

    assert result.state == "completed"
    assert result.ok is True
    assert result.pending is False
    assert (tmp_path / ".projectops").is_dir()
    assert session.list_pending() == []


def test_unknown_command_returns_error(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("unknown nonsense")

    assert result.state == "error"
    assert result.ok is False
    assert result.error_type == "UnknownIntent"
    assert session.list_pending() == []


def test_generated_request_id(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("status")

    assert result.request_id


def test_request_id_preservation(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("status", request_id="req-123")

    assert result.request_id == "req-123"
    assert result.response is not None
    assert result.response.request_id == "req-123"


def test_turn_result_is_json_serializable(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    result = session.handle_text("status", request_id="req-json")

    json.dumps(to_jsonable(result))


def test_session_does_not_persist_pending_state(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    first = AdapterSession(adapter)
    first.handle_text("init workspace", request_id="req-init")

    second = AdapterSession(adapter)

    assert first.has_pending("req-init") is True
    assert second.has_pending("req-init") is False
    assert second.list_pending() == []


def test_adapter_session_demo_script_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "status" in result.stdout
    assert "pending_confirmation" in result.stdout
    assert "confirm" in result.stdout
    assert "reject" in result.stdout
    assert "create task" in result.stdout
    assert "doctor" in result.stdout
    assert "PendingConfirmationNotFound" in result.stdout


def test_adapter_session_docs_and_links() -> None:
    session_doc = (ROOT / "docs" / "adapter_session_lifecycle.md").read_text(
        encoding="utf-8"
    )
    interface_doc = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )
    intent_doc = (ROOT / "docs" / "adapter_intent_mapping.md").read_text(
        encoding="utf-8"
    )
    usage_doc = (ROOT / "docs" / "adapter_usage_examples.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "AdapterSession" in session_doc
    assert "pending confirmation" in session_doc.lower()
    assert "confirm" in session_doc
    assert "reject" in session_doc
    assert "OpenClaw" in session_doc
    assert "in-memory" in session_doc
    assert "server" in session_doc
    assert "adapter_session_lifecycle.md" in readme
    assert "adapter_session_lifecycle" in interface_doc
    assert "adapter_session_lifecycle" in intent_doc
    assert "adapter_session_demo.py" in usage_doc
