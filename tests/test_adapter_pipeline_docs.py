from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PIPELINE_DOC = ROOT / "docs" / "adapter_pipeline_contract.md"


def test_adapter_pipeline_contract_doc_exists() -> None:
    assert PIPELINE_DOC.exists()


def test_readme_links_to_adapter_pipeline_contract() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/adapter_pipeline_contract.md" in readme


def test_external_adapter_interface_links_to_adapter_pipeline_contract() -> None:
    interface_doc = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )

    assert "adapter_pipeline_contract.md" in interface_doc


def test_adapter_pipeline_contract_mentions_required_boundaries() -> None:
    text = PIPELINE_DOC.read_text(encoding="utf-8")

    for expected in [
        "AdapterSession",
        "ProjectOpsServiceAdapter",
        "AdapterTurnResult",
        "AdapterResponse",
        "AdapterEvent",
        "AdapterTranscript",
        "map_text_to_adapter_request",
        "prepare_confirmation",
        "event_from_turn_result",
        "render_event_as_text",
        "OpenClaw",
        "source of truth",
        "mutation",
        "confirmation",
        "read-only",
        ".projectops",
    ]:
        assert expected in text


def test_adapter_pipeline_contract_mentions_non_goals() -> None:
    text = PIPELINE_DOC.read_text(encoding="utf-8").lower()

    for expected in [
        "no server",
        "no openclaw integration",
        "no external api",
        "no persistent session",
    ]:
        assert expected in text
