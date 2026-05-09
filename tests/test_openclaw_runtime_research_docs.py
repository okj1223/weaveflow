from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DOC = ROOT / "docs" / "openclaw_runtime_research.md"
GAP_DOC = ROOT / "docs" / "openclaw_integration_gap_analysis.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_openclaw_runtime_research_doc_exists() -> None:
    assert RUNTIME_DOC.exists()


def test_openclaw_integration_gap_analysis_doc_exists() -> None:
    assert GAP_DOC.exists()


def test_readme_links_runtime_research_and_gap_analysis() -> None:
    readme = read(ROOT / "README.md")

    assert "docs/openclaw_runtime_research.md" in readme
    assert "docs/openclaw_integration_gap_analysis.md" in readme


def test_openclaw_design_links_runtime_research_and_gap_analysis() -> None:
    doc = read(ROOT / "docs" / "openclaw_adapter_design.md")

    assert "openclaw_runtime_research.md" in doc
    assert "openclaw_integration_gap_analysis.md" in doc


def test_channel_contract_links_runtime_research_and_gap_analysis() -> None:
    doc = read(ROOT / "docs" / "channel_adapter_contract.md")

    assert "openclaw_runtime_research.md" in doc
    assert "openclaw_integration_gap_analysis.md" in doc


def test_openclaw_runtime_research_mentions_required_terms() -> None:
    doc = read(RUNTIME_DOC).lower()

    for term in [
        "openclaw",
        "gateway",
        "sessions",
        "channels",
        "websocket",
        "rpc",
        "configuration",
        "pairing",
        "allowlist",
        "sources reviewed",
        "confirmed facts",
        "unknowns",
        "integration modes",
    ]:
        assert term in doc


def test_openclaw_gap_analysis_mentions_required_terms() -> None:
    doc = read(GAP_DOC).lower()

    for term in [
        "openclawmessage",
        "openclawresponse",
        "normalize_openclaw_message_payload",
        "openclawadapter",
        "adaptersession",
        "permission policy",
        "payload mismatch",
        "auth/scope",
        "session mismatch",
        "python/node boundary",
        "recommended next phase",
        "blockers",
    ]:
        assert term in doc
