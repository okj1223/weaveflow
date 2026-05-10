from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIAGNOSTICS_DOC = ROOT / "docs" / "stdio_bridge_diagnostics_contract.md"


def test_diagnostics_contract_doc_exists() -> None:
    assert DIAGNOSTICS_DOC.exists()


def test_readme_links_to_diagnostics_contract() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/stdio_bridge_diagnostics_contract.md" in readme


def test_protocol_links_to_diagnostics_contract() -> None:
    protocol = (ROOT / "docs" / "stdio_bridge_protocol.md").read_text(
        encoding="utf-8"
    )

    assert "stdio_bridge_diagnostics_contract.md" in protocol


def test_client_contract_links_to_diagnostics_contract() -> None:
    client_contract = (ROOT / "docs" / "stdio_bridge_client_contract.md").read_text(
        encoding="utf-8"
    )

    assert "stdio_bridge_diagnostics_contract.md" in client_contract


def test_process_supervision_links_to_diagnostics_contract() -> None:
    process_supervision = (
        ROOT / "docs" / "stdio_bridge_process_supervision.md"
    ).read_text(encoding="utf-8")

    assert "stdio_bridge_diagnostics_contract.md" in process_supervision


def test_gap_analysis_mentions_diagnostics_contract() -> None:
    gap = (ROOT / "docs" / "openclaw_integration_gap_analysis.md").read_text(
        encoding="utf-8"
    )

    lower = gap.lower()
    assert "stderr diagnostics" in lower or "diagnostics contract" in lower


def test_diagnostics_contract_mentions_required_terms() -> None:
    doc = DIAGNOSTICS_DOC.read_text(encoding="utf-8")

    for term in [
        "stdout",
        "stderr",
        "protocol-only",
        "diagnostics-only",
        "bridge_request_id",
        "request_id",
        "diagnostic_version",
        "projectops.diagnostics.v1",
        "bridge_started",
        "request_completed",
        "normalization_error",
        "session_lost",
        "shutdown_requested",
        "sanitization",
        "secrets",
        "no server",
        "no network",
        "no OpenClaw integration",
    ]:
        assert term in doc
