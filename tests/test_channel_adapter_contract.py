import subprocess
from pathlib import Path

from projectops.adapters import (
    AdapterSession,
    ProjectOpsServiceAdapter,
    event_from_turn_result,
    render_event_for_channel,
)
from projectops.adapters.openclaw import OpenClawAdapter


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_DOC = ROOT / "docs" / "channel_adapter_contract.md"
DEMO_PATH = ROOT / "examples" / "channel_adapter_flow_demo.py"


def raw_payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-09T00:00:00Z",
        "threadId": "thread-1",
    }


def real_task_count() -> int:
    tasks_dir = ROOT / ".projectops" / "tasks"
    if not tasks_dir.is_dir():
        return 0
    return len([path for path in tasks_dir.iterdir() if path.name.startswith("TASK-")])


def test_channel_adapter_contract_doc_exists() -> None:
    assert CONTRACT_DOC.exists()


def test_readme_links_channel_adapter_contract() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/channel_adapter_contract.md" in readme


def test_openclaw_design_links_channel_adapter_contract() -> None:
    doc = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )

    assert "channel_adapter_contract.md" in doc


def test_pipeline_contract_links_channel_adapter_contract() -> None:
    doc = (ROOT / "docs" / "adapter_pipeline_contract.md").read_text(
        encoding="utf-8"
    )

    assert "channel_adapter_contract.md" in doc


def test_channel_adapter_contract_mentions_required_terms() -> None:
    doc = CONTRACT_DOC.read_text(encoding="utf-8")

    for term in [
        "normalize_openclaw_message_payload",
        "OpenClawMessage",
        "OpenClawAdapter",
        "AdapterSession",
        "AdapterSessionStore",
        "ProjectOpsServiceAdapter",
        "AdapterEvent",
        "render_event_for_channel",
        "OpenClawResponse",
        "openclaw_response_to_payload",
        "permission policy",
        "confirmation",
        "session key",
        "source of truth",
        ".projectops",
        "SQLite",
        "no real OpenClaw integration",
        "no server",
        "no external APIs",
    ]:
        assert term in doc


def test_channel_adapter_flow_demo_exists() -> None:
    assert DEMO_PATH.exists()


def test_channel_adapter_flow_demo_runs() -> None:
    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    for term in [
        "status payload",
        "init payload",
        "create task payload",
        "list tasks payload",
        "doctor payload",
        "bad payload",
        "OpenClawPayloadNormalizationError",
        "openclaw render",
        "log render",
    ]:
        assert term in result.stdout


def test_channel_adapter_flow_demo_does_not_modify_real_workspace() -> None:
    source = DEMO_PATH.read_text(encoding="utf-8")
    before = real_task_count()

    assert "TemporaryDirectory" in source
    assert 'Path(".")' not in source

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert real_task_count() == before


def test_local_raw_payload_flow_works(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    status = adapter.handle_payload(raw_payload("status", "msg-status"))
    pending_init = adapter.handle_payload(raw_payload("init workspace", "msg-init"))
    confirmed_init = adapter.handle_payload(raw_payload("yes", "msg-init-yes"))
    pending_task = adapter.handle_payload(
        raw_payload("create task Investigate auth bug", "msg-create")
    )
    confirmed_task = adapter.handle_payload(raw_payload("yes", "msg-create-yes"))
    doctor = adapter.handle_payload(raw_payload("doctor", "msg-doctor"))

    assert status["ok"] is True
    assert status["event_type"] == "turn_completed"
    assert pending_init["event_type"] == "pending_confirmation"
    assert confirmed_init["ok"] is True
    assert (tmp_path / ".projectops").is_dir()
    assert pending_task["event_type"] == "pending_confirmation"
    assert confirmed_task["ok"] is True
    assert (
        tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()
    assert doctor["ok"] is True


def test_channel_render_smoke(tmp_path: Path) -> None:
    session = AdapterSession(ProjectOpsServiceAdapter(tmp_path))
    event = event_from_turn_result(
        session.handle_text("status", request_id="render-status")
    )

    openclaw = render_event_for_channel(event, channel="openclaw")
    log = render_event_for_channel(event, channel="log")

    assert isinstance(openclaw, str)
    assert isinstance(log, str)
    assert "\n" not in log


def test_no_real_openclaw_import_dependency() -> None:
    files = list((ROOT / "src" / "projectops" / "adapters" / "openclaw").glob("*.py"))
    files.append(DEMO_PATH)

    for path in files:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip().lower()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")
