import subprocess
from pathlib import Path

import pytest

from projectops.adapters import (
    AdapterEvent,
    AdapterSession,
    AdapterTranscript,
    ChannelRenderPolicy,
    ProjectOpsServiceAdapter,
    event_from_turn_result,
    get_channel_render_policy,
    render_event_for_channel,
    render_transcript_for_channel,
)
from projectops.adapters.openclaw import OpenClawAdapter, OpenClawMessage


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_channel_rendering_demo.py"


def make_session(root: Path) -> AdapterSession:
    return AdapterSession(ProjectOpsServiceAdapter(root))


def status_event(root: Path) -> AdapterEvent:
    return event_from_turn_result(
        make_session(root).handle_text("status", request_id="req-status")
    )


def pending_event(root: Path) -> AdapterEvent:
    return event_from_turn_result(
        make_session(root).handle_text("init workspace", request_id="req-init")
    )


def error_event(root: Path) -> AdapterEvent:
    return event_from_turn_result(
        make_session(root).handle_text("unknown nonsense", request_id="req-error")
    )


def openclaw_msg(text: str, message_id: str) -> OpenClawMessage:
    return OpenClawMessage(
        channel_id="channel-1",
        user_id="user-1",
        message_id=message_id,
        text=text,
        timestamp="2026-05-09T00:00:00Z",
        thread_id="thread-1",
    )


def test_channel_rendering_imports() -> None:
    assert ChannelRenderPolicy
    assert get_channel_render_policy
    assert render_event_for_channel
    assert render_transcript_for_channel


@pytest.mark.parametrize(
    "channel, expected",
    [
        (
            "openclaw",
            {
                "style": "chat",
                "allow_markdown": True,
                "include_emoji": True,
                "include_metadata": False,
                "multiline": True,
            },
        ),
        (
            "slack",
            {
                "style": "chat",
                "allow_markdown": True,
                "include_emoji": True,
                "include_metadata": False,
                "multiline": True,
            },
        ),
        (
            "telegram",
            {
                "style": "chat",
                "allow_markdown": False,
                "include_emoji": True,
                "include_metadata": False,
                "multiline": True,
            },
        ),
        (
            "terminal",
            {
                "style": "chat",
                "allow_markdown": False,
                "include_emoji": True,
                "include_metadata": True,
                "multiline": True,
            },
        ),
        (
            "log",
            {
                "style": "log",
                "allow_markdown": False,
                "include_emoji": False,
                "include_metadata": True,
                "multiline": False,
            },
        ),
    ],
)
def test_supported_channel_policies(channel: str, expected: dict[str, object]) -> None:
    policy = get_channel_render_policy(channel)

    assert policy.channel == channel
    assert policy.style == expected["style"]
    assert policy.allow_markdown is expected["allow_markdown"]
    assert policy.include_emoji is expected["include_emoji"]
    assert policy.include_request_id is True
    assert policy.include_error_type is True
    assert policy.include_metadata is expected["include_metadata"]
    assert policy.multiline is expected["multiline"]


def test_unknown_channel_raises(tmp_path: Path) -> None:
    event = status_event(tmp_path)

    with pytest.raises(ValueError, match="Unknown adapter render channel"):
        get_channel_render_policy("unknown")
    with pytest.raises(ValueError, match="Unknown adapter render channel"):
        render_event_for_channel(event, channel="unknown")


def test_channel_names_are_case_insensitive() -> None:
    assert get_channel_render_policy("OpenClaw").channel == "openclaw"
    assert get_channel_render_policy("openclaw").channel == "openclaw"


def test_pending_confirmation_includes_hint_and_request_id(tmp_path: Path) -> None:
    rendered = render_event_for_channel(pending_event(tmp_path), channel="openclaw")

    assert "yes" in rendered.lower()
    assert "Reply yes to confirm or no to reject." in rendered
    assert "req-init" in rendered


def test_telegram_render_is_plain_text_with_request_id(tmp_path: Path) -> None:
    rendered = render_event_for_channel(status_event(tmp_path), channel="telegram")

    assert isinstance(rendered, str)
    assert "req-status" in rendered
    assert "[" not in rendered or "[truncated]" in rendered


def test_log_style_is_single_line(tmp_path: Path) -> None:
    rendered = render_event_for_channel(status_event(tmp_path), channel="log")

    assert "\n" not in rendered
    assert "request_id=req-status" in rendered
    assert "action=status" in rendered or "completed" in rendered


def test_error_render_includes_error_type(tmp_path: Path) -> None:
    rendered = render_event_for_channel(error_event(tmp_path), channel="openclaw")

    assert "UnknownIntent" in rendered


def test_absolute_path_redaction() -> None:
    event = AdapterEvent(
        request_id="req-path",
        event_type="turn_completed",
        level="info",
        state="completed",
        action="status",
        message="Wrote /tmp/example/file.txt for review.",
    )

    openclaw = render_event_for_channel(event, channel="openclaw")
    terminal = render_event_for_channel(event, channel="terminal")

    assert "/tmp/example/file.txt" not in openclaw
    assert "<path>" in openclaw
    assert "/tmp/example/file.txt" in terminal


def test_truncation_for_long_messages() -> None:
    event = AdapterEvent(
        request_id="req-long",
        event_type="turn_completed",
        level="info",
        state="completed",
        action="status",
        message="x" * 2000,
    )

    rendered = render_event_for_channel(event, channel="telegram")

    assert "[truncated]" in rendered
    assert len(rendered) <= get_channel_render_policy("telegram").max_length


def test_transcript_rendering(tmp_path: Path) -> None:
    events = [status_event(tmp_path), pending_event(tmp_path)]
    transcript = AdapterTranscript(session_id="session-1", events=events)

    openclaw = render_transcript_for_channel(transcript, channel="openclaw")
    log = render_transcript_for_channel(transcript, channel="log")

    assert "session-1" in openclaw
    assert "status" in openclaw
    assert "pending_confirmation" in openclaw or "Confirmation" in openclaw
    assert isinstance(log, str)
    assert "\n" not in log


def test_rendering_does_not_touch_files(tmp_path: Path) -> None:
    event = status_event(tmp_path)

    assert not (tmp_path / ".projectops").exists()
    render_event_for_channel(event, channel="openclaw")
    render_transcript_for_channel(
        AdapterTranscript(session_id="session-1", events=[event]),
        channel="openclaw",
    )
    assert not (tmp_path / ".projectops").exists()


def test_adapter_channel_rendering_demo_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "openclaw" in result.stdout
    assert "telegram" in result.stdout
    assert "log" in result.stdout
    assert "pending_confirmation" in result.stdout
    assert "turn_error" in result.stdout


def test_channel_rendering_docs_and_links() -> None:
    renderer_doc = (ROOT / "docs" / "adapter_renderer_policy.md").read_text(
        encoding="utf-8"
    )
    openclaw_doc = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "ChannelRenderPolicy" in renderer_doc
    for term in ["openclaw", "slack", "telegram", "terminal", "log"]:
        assert term in renderer_doc
    assert "render_event_for_channel" in openclaw_doc
    assert "docs/adapter_renderer_policy.md" in readme


def test_openclaw_runtime_compatibility(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    pending = adapter.handle_message(openclaw_msg("init workspace", "m-init"))
    confirmed = adapter.handle_message(openclaw_msg("yes", "m-yes"))

    assert pending.event_type == "pending_confirmation"
    assert confirmed.ok is True
    assert (tmp_path / ".projectops").is_dir()
