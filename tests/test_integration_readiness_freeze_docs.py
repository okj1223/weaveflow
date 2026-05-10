from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "integration_readiness_freeze.md"


def test_integration_readiness_freeze_doc_exists() -> None:
    assert DOC_PATH.exists()


def test_readme_links_to_integration_readiness_freeze() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/integration_readiness_freeze.md" in readme


def test_integration_readiness_freeze_mentions_required_terms() -> None:
    doc = DOC_PATH.read_text(encoding="utf-8")

    for term in [
        "ProjectOps core workflow",
        "stdio bridge",
        "OpenClaw",
        "local wrapper",
        "permission preflight",
        "explicit confirmation",
        "replay protection",
        "wrapper notifications",
        "in-memory",
        "source of truth",
        ".projectops",
        "SQLite",
        "stop criteria",
        "smallest future POC",
        "no real OpenClaw integration",
        "no auth",
        "no persistent sessions",
    ]:
        assert term in doc


def test_openclaw_gap_analysis_links_to_freeze() -> None:
    gap = (ROOT / "docs" / "openclaw_integration_gap_analysis.md").read_text(
        encoding="utf-8"
    )

    assert "integration_readiness_freeze.md" in gap
