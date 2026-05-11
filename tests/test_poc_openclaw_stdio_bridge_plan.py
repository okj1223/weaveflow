from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "poc_openclaw_stdio_bridge_plan.md"


def test_poc_openclaw_stdio_bridge_plan_exists() -> None:
    assert DOC_PATH.exists()


def test_poc_openclaw_stdio_bridge_plan_mentions_required_terms() -> None:
    doc = DOC_PATH.read_text(encoding="utf-8")
    lower_doc = doc.lower()

    for term in [
        "poc/openclaw-stdio-bridge",
        "v0.1.0-integration-freeze",
        "weaveflow.adapters.stdio_bridge",
        "ping",
        "handle_payload",
        "shutdown",
        "status",
        "create task",
        "pending confirmation",
        "task list",
        "OpenClaw",
    ]:
        assert term in doc

    for term in [
        "non-goals",
        "stop criteria",
    ]:
        assert term in lower_doc
