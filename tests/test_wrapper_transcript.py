import json
import subprocess
import sys
from pathlib import Path

from weaveflow.adapters.local_wrapper import LocalBridgeWrapper
from weaveflow.adapters.permission_preflight import preflight_openclaw_payload
from weaveflow.adapters.wrapper_rendering import render_wrapper_result_as_text
from weaveflow.adapters.wrapper_transcript import (
    WrapperTranscript,
    WrapperTranscriptEntry,
    create_wrapper_transcript_entry,
    run_payloads_with_transcript,
    sanitize_transcript_payload,
    transcript_to_json,
    transcript_to_markdown,
)


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "wrapper_transcript_review.md"
DEMO_PATH = ROOT / "examples" / "wrapper_transcript_demo.py"


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
        payload("create task Wrapper transcript test task", "m-create")
    )
    assert pending.route_reason == "route_to_establish_pending_confirmation"
    confirmed = wrapper.handle_payload(payload("yes", "m-create-yes"))
    assert confirmed.ok is True
    assert root.joinpath(".weaveflow", "tasks", "TASK-0001", "task_spec.yaml").exists()


def setup_workspace_and_task(tmp_path: Path) -> LocalBridgeWrapper:
    wrapper = start_wrapper(tmp_path)
    initialize_workspace(wrapper)
    create_task(wrapper, tmp_path)
    return wrapper


def bridge_event_type(entry: WrapperTranscriptEntry) -> str | None:
    if entry.route_result is None:
        return None
    bridge_response = entry.route_result.get("bridge_response")
    if not isinstance(bridge_response, dict):
        return None
    response = bridge_response.get("response")
    if not isinstance(response, dict):
        return None
    event_type = response.get("event_type")
    return event_type if isinstance(event_type, str) else None


def test_imports() -> None:
    assert WrapperTranscriptEntry
    assert WrapperTranscript
    assert create_wrapper_transcript_entry
    assert transcript_to_json
    assert transcript_to_markdown
    assert run_payloads_with_transcript


def test_create_entry_from_status_result(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        raw = payload("status", "m-status")
        preflight = preflight_openclaw_payload(raw, bridge_request_id="b-status")
        result = wrapper.handle_payload(raw, bridge_request_id="b-status")
        rendered = render_wrapper_result_as_text(result)

        entry = create_wrapper_transcript_entry(
            label="status",
            channel="openclaw",
            payload=raw,
            preflight=preflight,
            route_result=result,
            rendered_text=rendered,
        )

        assert entry.action == "status"
        assert entry.routed is True
        assert entry.blocked is False
        assert entry.ok is True
        assert entry.rendered_text
    finally:
        wrapper.shutdown()


def test_entry_captures_blocked_high_risk(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        raw = payload("auto run codex", "m-risk")
        preflight = preflight_openclaw_payload(raw, bridge_request_id="b-risk")
        result = wrapper.handle_payload(raw, bridge_request_id="b-risk")
        entry = create_wrapper_transcript_entry(
            label="auto_run_codex",
            channel="openclaw",
            payload=raw,
            preflight=preflight,
            route_result=result,
            rendered_text=render_wrapper_result_as_text(result),
        )

        assert entry.category == "future_high_risk"
        assert entry.blocked is True
        assert entry.routed is False
    finally:
        wrapper.shutdown()


def test_entry_captures_notification(tmp_path: Path) -> None:
    wrapper = setup_workspace_and_task(tmp_path)
    try:
        wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        result = wrapper.handle_explicit_confirmation("yes", bridge_request_id="b-verify")
        entry = create_wrapper_transcript_entry(
            label="wrong explicit phrase",
            channel="openclaw",
            payload=payload("yes", "m-wrong"),
            route_result=result,
            rendered_text=render_wrapper_result_as_text(result),
        )

        assert entry.notification is not None
        assert entry.notification["notification_type"] == "explicit_confirmation_mismatch"
    finally:
        wrapper.shutdown()


def test_transcript_add_entry_preserves_order() -> None:
    first = create_wrapper_transcript_entry(
        label="first",
        channel="openclaw",
        payload=payload("status", "m-first"),
        rendered_text="first rendered",
    )
    second = create_wrapper_transcript_entry(
        label="second",
        channel="openclaw",
        payload=payload("doctor", "m-second"),
        rendered_text="second rendered",
    )
    transcript = WrapperTranscript(channel="openclaw")

    transcript.add_entry(first)
    transcript.add_entry(second)

    assert len(transcript.entries) == 2
    assert [entry.label for entry in transcript.entries] == ["first", "second"]


def test_transcript_json_serializable() -> None:
    transcript = WrapperTranscript(channel="openclaw")
    transcript.add_entry(
        create_wrapper_transcript_entry(
            label="status",
            channel="openclaw",
            payload=payload("status", "m-status"),
            rendered_text="Routed: status.",
        )
    )

    parsed = json.loads(transcript_to_json(transcript))

    assert parsed["channel"] == "openclaw"
    assert len(parsed["entries"]) == 1


def test_transcript_markdown() -> None:
    transcript = WrapperTranscript(channel="openclaw")
    transcript.add_entry(
        create_wrapper_transcript_entry(
            label="status",
            channel="openclaw",
            payload=payload("status", "m-status"),
            rendered_text="Routed: status.",
        )
    )

    rendered = transcript_to_markdown(transcript)

    assert "status" in rendered
    assert "routed" in rendered
    assert "blocked" in rendered


def test_payload_sanitization_does_not_mutate_original() -> None:
    original = {"content": "inspect /tmp/example/file.txt"}

    sanitized = sanitize_transcript_payload(original)

    assert original["content"] == "inspect /tmp/example/file.txt"
    assert "/tmp/example/file.txt" not in json.dumps(sanitized)


def test_run_payloads_with_transcript_basic_flow(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        transcript = run_payloads_with_transcript(
            wrapper,
            [
                payload("status", "m-status"),
                payload("init workspace", "m-init"),
                payload("yes", "m-init-yes"),
                payload("create task Transcript task", "m-create"),
                payload("yes", "m-create-yes"),
                payload("list tasks", "m-list"),
                payload("doctor", "m-doctor"),
            ],
        )

        assert len(transcript.entries) == 7
        assert any(bridge_event_type(entry) == "pending_confirmation" for entry in transcript.entries)
        assert any(bridge_event_type(entry) == "turn_completed" for entry in transcript.entries)
        assert tmp_path.joinpath(".weaveflow", "tasks", "TASK-0001", "task_spec.yaml").exists()
    finally:
        wrapper.shutdown()


def test_run_payloads_captures_bad_payload(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        transcript = run_payloads_with_transcript(
            wrapper,
            [payload("status", "m-status"), {"content": "bad payload"}],
        )

        bad_entry = transcript.entries[-1]
        assert bad_entry.ok is False or bad_entry.blocked is True
        assert bad_entry.error_type == "OpenClawPayloadNormalizationError"
    finally:
        wrapper.shutdown()


def test_transcript_helper_does_not_auto_confirm(tmp_path: Path) -> None:
    wrapper = start_wrapper(tmp_path)
    try:
        transcript = run_payloads_with_transcript(
            wrapper,
            [
                payload("init workspace", "m-init"),
                payload("yes", "m-init-yes"),
                payload("create task Pending only task", "m-create"),
            ],
        )

        assert len(transcript.entries) == 3
        assert bridge_event_type(transcript.entries[-1]) == "pending_confirmation"
        assert not tmp_path.joinpath(".weaveflow", "tasks", "TASK-0001").exists()
    finally:
        wrapper.shutdown()


def test_wrapper_transcript_demo_runs() -> None:
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
        "transcript",
        "JSON",
        "Markdown",
        "status",
        "create_task",
        "auto_run_codex",
        "bad payload",
    ]:
        assert term in result.stdout


def test_wrapper_transcript_docs() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    local_wrapper = (ROOT / "docs" / "local_wrapper_flow.md").read_text(
        encoding="utf-8"
    )
    rendering = (ROOT / "docs" / "wrapper_result_rendering.md").read_text(
        encoding="utf-8"
    )
    openclaw_design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/wrapper_transcript_review.md" in readme
    assert "wrapper_transcript_review.md" in local_wrapper
    assert "wrapper_transcript_review.md" in rendering
    assert "transcript review" in openclaw_design
    for term in [
        "WrapperTranscript",
        "WrapperTranscriptEntry",
        "preflight",
        "route result",
        "rendered text",
        "source of truth",
        "OpenClaw",
        "not persistent",
        "not authentication",
    ]:
        assert term in doc
