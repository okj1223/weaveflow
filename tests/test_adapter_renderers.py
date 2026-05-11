import subprocess
from pathlib import Path

import pytest

from weaveflow.adapters import (
    AdapterEvent,
    AdapterSession,
    AdapterTranscript,
    WeaveflowServiceAdapter,
    event_from_turn_result,
    render_event_as_text,
    render_event_summary,
    render_transcript_as_text,
)


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_renderer_demo.py"


def make_session(root: Path) -> AdapterSession:
    return AdapterSession(WeaveflowServiceAdapter(root))


def test_adapter_renderer_imports() -> None:
    assert render_event_as_text
    assert render_transcript_as_text
    assert render_event_summary


def test_completed_event_chat_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status", request_id="req-status"))
    rendered = render_event_as_text(event)

    assert isinstance(rendered, str)
    assert "Completed" in rendered
    assert "status" in rendered


def test_pending_confirmation_chat_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(
        session.handle_text("init workspace", request_id="req-init")
    )
    rendered = render_event_as_text(event)

    assert "Confirmation" in rendered
    assert "init_workspace" in rendered
    assert "req-init" in rendered


def test_rejected_event_chat_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    session.handle_text("init workspace", request_id="req-init")
    event = event_from_turn_result(session.reject("req-init"))
    rendered = render_event_as_text(event)

    assert "Rejected" in rendered


def test_error_event_chat_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(
        session.handle_text("unknown nonsense", request_id="req-error")
    )
    rendered = render_event_as_text(event)

    assert "Error" in rendered
    assert "UnknownIntent" in rendered


def test_completed_mutation_chat_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(
        session.handle_text(
            "init workspace",
            request_id="req-init",
            allow_mutation=True,
        )
    )
    rendered = render_event_as_text(event)

    assert "init_workspace" in rendered


def test_log_style_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status", request_id="req-status"))
    rendered = render_event_as_text(event, style="log")

    assert "INFO" in rendered or "completed" in rendered
    assert "\n" not in rendered


def test_pending_log_style_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(
        session.handle_text("init workspace", request_id="req-init")
    )
    rendered = render_event_as_text(event, style="log")

    assert "WARN" in rendered or "pending_confirmation" in rendered


def test_error_log_style_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(
        session.handle_text("unknown nonsense", request_id="req-error")
    )
    rendered = render_event_as_text(event, style="log")

    assert "ERROR" in rendered or "turn_error" in rendered


def test_unknown_style_raises_value_error(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status"))

    with pytest.raises(ValueError):
        render_event_as_text(event, style="unknown")


def test_transcript_render(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    events = [
        event_from_turn_result(session.handle_text("status", request_id="req-status")),
        event_from_turn_result(
            session.handle_text("init workspace", request_id="req-init")
        ),
    ]
    transcript = AdapterTranscript(session_id="session-1", events=events)
    rendered = render_transcript_as_text(transcript, style="log")

    assert "session-1" in rendered
    assert "Event count: 2" in rendered
    assert "status" in rendered
    assert "init_workspace" in rendered


def test_renderer_does_not_touch_files(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status"))

    assert not (tmp_path / ".weaveflow").exists()
    render_event_as_text(event)
    render_transcript_as_text(AdapterTranscript(session_id="session-1", events=[event]))

    assert not (tmp_path / ".weaveflow").exists()


def test_renderer_handles_missing_optional_data() -> None:
    event = AdapterEvent(
        request_id="req-minimal",
        event_type="turn_completed",
        level="info",
        state="completed",
        action=None,
        message="Minimal event",
    )

    rendered = render_event_as_text(event)

    assert "Completed" in rendered
    assert "Minimal event" in rendered


def test_render_event_summary(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    event = event_from_turn_result(session.handle_text("status", request_id="req-status"))

    assert render_event_summary(event) == "completed action=status request_id=req-status"


def test_adapter_renderer_demo_script_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Completed" in result.stdout
    assert "Confirmation" in result.stdout
    assert "Rejected" in result.stdout
    assert "Error" in result.stdout
    assert "transcript" in result.stdout.lower()


def test_adapter_renderer_docs_and_links() -> None:
    renderer_doc = (ROOT / "docs" / "adapter_renderer_policy.md").read_text(
        encoding="utf-8"
    )
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

    assert "AdapterEvent" in renderer_doc
    assert "AdapterTranscript" in renderer_doc
    assert "render_event_as_text" in renderer_doc
    assert "OpenClaw" in renderer_doc
    assert "chat" in renderer_doc
    assert "log" in renderer_doc
    assert "source of truth" in renderer_doc
    assert "adapter_renderer_policy.md" in readme
    assert "adapter_renderer_policy" in event_doc
    assert "adapter_renderer_policy" in session_doc
    assert "adapter_renderer_policy" in interface_doc
    assert "adapter_renderer_demo.py" in usage_doc
