from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8").lower()


def test_repository_hygiene_doc_exists() -> None:
    assert (ROOT / "docs" / "repository_hygiene.md").exists()


def test_readme_links_to_repository_hygiene_doc() -> None:
    text = read_text("README.md")

    assert "docs/repository_hygiene.md" in text


def test_gitignore_exists_with_local_state_policy() -> None:
    text = read_text(".gitignore")

    for expected in [
        ".projectops/",
        ".projectops/state.sqlite",
        ".projectops/tasks/",
        "examples/*_codex_result.md",
        "__pycache__/",
        ".pytest_cache/",
    ]:
        assert expected in text
