import importlib.util
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_usage_demo.py"
DOC_PATH = ROOT / "docs" / "adapter_usage_examples.md"


def task_dirs() -> set[str]:
    tasks_dir = ROOT / ".weaveflow" / "tasks"
    if not tasks_dir.is_dir():
        return set()
    return {path.name for path in tasks_dir.glob("TASK-*") if path.is_dir()}


def test_demo_script_exists() -> None:
    assert DEMO_PATH.exists()


def test_demo_script_is_import_safe() -> None:
    spec = importlib.util.spec_from_file_location("adapter_usage_demo", DEMO_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)

    spec.loader.exec_module(module)

    assert hasattr(module, "main")


def test_demo_script_runs_successfully() -> None:
    before_tasks = task_dirs()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "status before init" in result.stdout
    assert "init_workspace" in result.stdout
    assert "create_task" in result.stdout
    assert "create_plan" in result.stdout
    assert "create_worker_brief" in result.stdout
    assert "list_tasks" in result.stdout
    assert "doctor" in result.stdout
    assert "MutationNotAllowed" in result.stdout
    assert "UnsupportedAction" in result.stdout
    assert task_dirs() == before_tasks


def test_demo_uses_temporary_workspace_source() -> None:
    source = DEMO_PATH.read_text(encoding="utf-8")

    assert "TemporaryDirectory" in source
    assert 'WeaveflowServiceAdapter(Path("."))' not in source
    assert "WeaveflowServiceAdapter(root)" in source


def test_adapter_usage_documentation_exists() -> None:
    assert DOC_PATH.exists()


def test_adapter_usage_documentation_mentions_key_terms() -> None:
    text = DOC_PATH.read_text(encoding="utf-8")

    for expected in [
        "WeaveflowServiceAdapter",
        "AdapterRequest",
        "AdapterResponse",
        "OpenClaw",
        "allow_mutation",
        "MutationNotAllowed",
        "contract_version",
        "TemporaryDirectory",
    ]:
        assert expected in text


def test_readme_links_to_adapter_usage_examples() -> None:
    text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "docs/adapter_usage_examples.md" in text
