from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESIGN_DOC = ROOT / "docs" / "openclaw_adapter_design.md"


def test_openclaw_adapter_design_doc_exists() -> None:
    assert DESIGN_DOC.exists()


def test_readme_links_to_openclaw_adapter_design() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/openclaw_adapter_design.md" in readme


def test_external_adapter_interface_links_to_openclaw_adapter_design() -> None:
    interface_doc = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )

    assert "openclaw_adapter_design.md" in interface_doc


def test_adapter_pipeline_contract_links_to_openclaw_adapter_design() -> None:
    pipeline_doc = (ROOT / "docs" / "adapter_pipeline_contract.md").read_text(
        encoding="utf-8"
    )

    assert "openclaw_adapter_design.md" in pipeline_doc


def test_openclaw_adapter_design_mentions_required_terms() -> None:
    text = DESIGN_DOC.read_text(encoding="utf-8")

    for expected in [
        "OpenClaw",
        "OpenClawMessage",
        "OpenClawResponse",
        "AdapterSession",
        "WeaveflowServiceAdapter",
        "AdapterEvent",
        "render_event_as_text",
        "request_id",
        "confirmation",
        "session ownership",
        "permission",
        "mutation",
        "source of truth",
        ".weaveflow",
        "SQLite",
        "no server",
        "no external APIs",
        "no OpenClaw integration",
    ]:
        assert expected in text
