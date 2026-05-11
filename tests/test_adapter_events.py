import json
import subprocess
from pathlib import Path

from weaveflow.adapters import (
    AdapterEvent,
    AdapterSession,
    AdapterTranscript,
    WeaveflowServiceAdapter,
    event_from_turn_result,
    transcript_from_turns,
)
from weaveflow.json_io import CONTRACT_VERSION, to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_event_demo.py"


def make_session(root: Path) -> AdapterSession:
    return AdapterSession(WeaveflowServiceAdapter(root))


def test_adapter_event_imports() -> None:
    assert AdapterEvent
    assert AdapterTranscript
    assert event_from_turn_result
    assert transcript_from_turns


def test_status_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text("status", request_id="req-status")
    event = event_from_turn_result(turn)

    assert event.event_type == "turn_completed"
    assert event.level == "info"
    assert event.state == "completed"
    assert event.action == "status"
    assert event.request_id == "req-status"
    json.dumps(to_jsonable(event))


def test_pending_confirmation_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text("init workspace", request_id="req-init")
    event = event_from_turn_result(turn)

    assert event.event_type == "pending_confirmation"
    assert event.level == "warning"
    assert event.state == "pending_confirmation"
    assert event.action == "init_workspace"


def test_rejected_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    session.handle_text("init workspace", request_id="req-init")
    turn = session.reject("req-init")
    event = event_from_turn_result(turn)

    assert event.event_type == "turn_rejected"
    assert event.level == "info"
    assert event.state == "rejected"


def test_error_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text("unknown nonsense", request_id="req-error")
    event = event_from_turn_result(turn)

    assert event.event_type == "turn_error"
    assert event.level == "error"
    assert event.state == "error"
    assert event.error_type


def test_completed_mutation_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text(
        "init workspace",
        request_id="req-init",
        allow_mutation=True,
    )
    event = event_from_turn_result(turn)

    assert event.event_type == "turn_completed"
    assert event.level == "info"
    assert event.state == "completed"
    assert event.action == "init_workspace"


def test_transcript_ordering(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turns = [
        session.handle_text("status", request_id="req-status"),
        session.handle_text("init workspace", request_id="req-init"),
        session.reject("req-init"),
    ]
    transcript = transcript_from_turns("session-1", turns)

    assert transcript.session_id == "session-1"
    assert transcript.contract_version == CONTRACT_VERSION
    assert [event.request_id for event in transcript.events] == [
        "req-status",
        "req-init",
        "req-init",
    ]


def test_transcript_add_event(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text("status", request_id="req-status")
    event = event_from_turn_result(turn)
    transcript = AdapterTranscript(session_id="session-1")

    transcript.add_event(event)

    assert len(transcript.events) == 1
    assert transcript.to_dict()["events"][0]["request_id"] == "req-status"


def test_event_data_json_safety_for_create_task(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    init = session.handle_text("init workspace", allow_mutation=True)
    assert init.ok is True

    turn = session.handle_text(
        "create task Event data safety",
        request_id="req-task",
        allow_mutation=True,
    )
    event = event_from_turn_result(turn)

    json.dumps(to_jsonable(event))
    assert event.data["response"]["data"]["id"] == "TASK-0001"


def test_event_ids_are_non_empty_and_unique_enough(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    first = event_from_turn_result(session.handle_text("status", request_id="req-1"))
    second = event_from_turn_result(session.handle_text("status", request_id="req-2"))

    assert first.event_id
    assert second.event_id
    assert first.event_id != second.event_id


def test_created_at_exists(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status"))

    assert isinstance(event.created_at, str)
    assert event.created_at


def test_event_helper_does_not_touch_files(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    turn = session.handle_text("status", request_id="req-status")

    assert not (tmp_path / ".weaveflow").exists()
    event_from_turn_result(turn)
    transcript_from_turns("session-1", [turn])

    assert not (tmp_path / ".weaveflow").exists()


def test_adapter_event_demo_script_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "turn_completed" in result.stdout
    assert "pending_confirmation" in result.stdout
    assert "turn_rejected" in result.stdout
    assert "turn_error" in result.stdout
    assert "transcript event count" in result.stdout


def test_adapter_event_docs_and_links() -> None:
    event_doc = (ROOT / "docs" / "adapter_event_model.md").read_text(
        encoding="utf-8"
    )
    session_doc = (ROOT / "docs" / "adapter_session_lifecycle.md").read_text(
        encoding="utf-8"
    )
    interface_doc = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )
    usage_doc = (ROOT / "docs" / "adapter_usage_examples.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "AdapterEvent" in event_doc
    assert "AdapterTranscript" in event_doc
    assert "AdapterTurnResult" in event_doc
    assert "OpenClaw" in event_doc
    assert "event_from_turn_result" in event_doc
    assert "source of truth" in event_doc
    assert "adapter_event_model.md" in readme
    assert "adapter_event_model" in session_doc
    assert "adapter_event_model" in interface_doc
    assert "adapter_event_demo.py" in usage_doc
