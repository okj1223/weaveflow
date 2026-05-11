from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_doc(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8").lower()


def test_external_adapter_interface_doc_exists() -> None:
    assert (ROOT / "docs" / "external_adapter_interface.md").exists()


def test_contract_changelog_doc_exists() -> None:
    assert (ROOT / "docs" / "contract_changelog.md").exists()


def test_external_adapter_interface_mentions_key_policies() -> None:
    text = read_doc("docs/external_adapter_interface.md")

    for expected in [
        "openclaw",
        "service functions",
        "cli json",
        "weaveflowerror",
        "contract_version",
        "read-only",
        "mutating",
    ]:
        assert expected in text


def test_contract_changelog_mentions_contract_terms() -> None:
    text = read_doc("docs/contract_changelog.md")

    for expected in [
        "weaveflow.v1",
        "status",
        "task list",
        "doctor",
        "breaking change",
        "backward-compatible",
    ]:
        assert expected in text


def test_readme_links_to_external_adapter_interface() -> None:
    text = read_doc("README.md")

    assert "docs/external_adapter_interface.md" in text


def test_adapter_contracts_links_to_contract_changelog() -> None:
    text = read_doc("docs/adapter_contracts.md")

    assert "contract_changelog.md" in text
