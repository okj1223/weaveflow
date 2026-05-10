from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SUPERVISION_DOC = ROOT / "docs" / "stdio_bridge_process_supervision.md"


def test_process_supervision_doc_exists() -> None:
    assert SUPERVISION_DOC.exists()


def test_readme_links_to_process_supervision_doc() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/stdio_bridge_process_supervision.md" in readme


def test_client_contract_links_to_process_supervision_doc() -> None:
    client_contract = (ROOT / "docs" / "stdio_bridge_client_contract.md").read_text(
        encoding="utf-8"
    )

    assert "stdio_bridge_process_supervision.md" in client_contract


def test_protocol_links_to_process_supervision_doc() -> None:
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )

    assert "stdio_bridge_process_supervision.md" in protocol


def test_gap_analysis_mentions_process_supervision() -> None:
    gap = (ROOT / "docs" / "openclaw_integration_gap_analysis.md").read_text(
        encoding="utf-8"
    )

    assert "process supervision" in gap.lower()


def test_process_supervision_doc_mentions_required_terms() -> None:
    doc = SUPERVISION_DOC.read_text(encoding="utf-8")

    for term in [
        "stdin",
        "stdout",
        "stderr",
        "bridge_request_id",
        "request_id",
        "timeout",
        "restart",
        "shutdown",
        "ping",
        "doctor",
        "session loss",
        "pending confirmations",
        "source of truth",
        ".projectops",
        "SQLite",
        "no server",
        "no network",
        "no authentication",
        "OpenClaw",
        "process wrapper",
        "do not auto-retry mutating actions",
    ]:
        assert term in doc
