import sqlite3
from pathlib import Path

import pytest
from typer.testing import CliRunner

from projectops.cli import app
from projectops.yaml_io import read_yaml


runner = CliRunner()
WORKSPACE_ERROR = "ProjectOps workspace not found. Run `ops init` first."


def task_status(db_path: Path, task_id: str) -> str:
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT status FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    assert row is not None
    return str(row[0])


def assert_clean_failure(result, message: str) -> None:
    assert result.exit_code != 0, result.output
    assert message in result.output
    assert "Traceback" not in result.output


def test_task_ids_files_and_sqlite_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    first = runner.invoke(app, ["task", "create", "First task"])
    second = runner.invoke(app, ["task", "create", "Second task"])

    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output
    assert "Created task: TASK-0001" in first.output
    assert "Created task: TASK-0002" in second.output

    first_task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert (first_task_dir / "task_spec.yaml").is_file()
    assert (first_task_dir / "artifacts").is_dir()
    assert task_status(tmp_path / ".projectops" / "state.sqlite", "TASK-0001") == "draft"


@pytest.mark.parametrize(
    "command",
    [
        ["task", "create", "Needs init"],
        ["task", "show", "TASK-0001"],
        ["task", "plan", "TASK-0001"],
        ["task", "brief", "TASK-0001", "--worker", "codex"],
    ],
)
def test_missing_workspace_errors_are_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: list[str]
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, command)

    assert_clean_failure(result, WORKSPACE_ERROR)


def test_task_list_fails_cleanly_before_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["task", "list"])

    assert_clean_failure(result, WORKSPACE_ERROR)


def test_task_list_reports_no_tasks_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["task", "list"])

    assert result.exit_code == 0, result.output
    assert result.output.strip() == "No tasks found."


def test_task_list_includes_required_fields_and_preserves_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "List this task"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    yaml_status_before = read_yaml(task_dir / "task_spec.yaml")["status"]
    sqlite_status_before = task_status(db_path, "TASK-0001")

    result = runner.invoke(app, ["task", "list"])

    assert result.exit_code == 0, result.output
    columns = result.output.strip().split(" | ")
    assert columns[0] == "TASK-0001"
    assert columns[1] == "draft"
    assert columns[2] == "List this task"
    assert columns[3]
    assert columns[4]
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == yaml_status_before
    assert task_status(db_path, "TASK-0001") == sqlite_status_before


@pytest.mark.parametrize(
    "command",
    [
        ["task", "show", "TASK-9999"],
        ["task", "plan", "TASK-9999"],
        ["task", "brief", "TASK-9999", "--worker", "codex"],
        ["task", "attach-result", "TASK-9999", "result.md"],
        ["task", "verify", "TASK-9999", "--status", "passed", "--note", "manual"],
        ["task", "report", "TASK-9999"],
        ["memory", "propose", "TASK-9999"],
    ],
)
def test_missing_task_errors_are_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: list[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    (tmp_path / "result.md").write_text("# Result\n", encoding="utf-8")

    result = runner.invoke(app, command)

    assert_clean_failure(result, "Task TASK-9999 not found.")


def test_brief_requires_existing_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Needs a plan"]).exit_code == 0

    result = runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "codex"])

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert_clean_failure(
        result,
        "Plan not found for TASK-0001. Run `ops task plan TASK-0001` first.",
    )
    assert not (task_dir / "worker_brief_codex.md").exists()
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"


def test_attach_result_requires_existing_source_and_preserves_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Attach missing result"]).exit_code == 0

    result = runner.invoke(
        app,
        ["task", "attach-result", "TASK-0001", "missing.md"],
    )

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert_clean_failure(result, "Result file not found: missing.md")
    assert not (task_dir / "artifacts.yaml").exists()
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"
    assert task_status(tmp_path / ".projectops" / "state.sqlite", "TASK-0001") == "draft"


def test_unsupported_worker_preserves_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Brief this task"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0

    result = runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "claude"])

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert_clean_failure(result, "Unsupported worker: claude. Supported workers: codex")
    assert not (task_dir / "worker_brief_claude.md").exists()
    assert not (task_dir / "worker_brief_codex.md").exists()
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "planned"
    assert task_status(tmp_path / ".projectops" / "state.sqlite", "TASK-0001") == "planned"


def test_invalid_verification_status_preserves_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Verify carefully"]).exit_code == 0

    result = runner.invoke(
        app,
        [
            "task",
            "verify",
            "TASK-0001",
            "--status",
            "maybe",
            "--note",
            "should fail",
        ],
    )

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert_clean_failure(
        result,
        "Invalid verification status: maybe. Expected one of: passed, failed, blocked",
    )
    assert not (task_dir / "verification_record.yaml").exists()
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"
    assert task_status(tmp_path / ".projectops" / "state.sqlite", "TASK-0001") == "draft"


def test_plan_brief_and_status_transitions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Plan this task"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"

    plan_result = runner.invoke(app, ["task", "plan", "TASK-0001"])
    assert plan_result.exit_code == 0, plan_result.output
    plan = read_yaml(task_dir / "plan.yaml")
    assert len(plan["nodes"]) == 4
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "planned"
    assert task_status(db_path, "TASK-0001") == "planned"

    brief_result = runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "codex"])
    assert brief_result.exit_code == 0, brief_result.output
    brief = (task_dir / "worker_brief_codex.md").read_text(encoding="utf-8")
    assert "Plan this task" in brief
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "briefed"
    assert task_status(db_path, "TASK-0001") == "briefed"


def test_attach_result_and_verification_statuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Attach a result"]).exit_code == 0

    result_file = tmp_path / "result.md"
    result_file.write_text("# Result\n", encoding="utf-8")
    attach = runner.invoke(
        app,
        ["task", "attach-result", "TASK-0001", str(result_file)],
    )
    assert attach.exit_code == 0, attach.output

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert (task_dir / "artifacts" / "result.md").is_file()
    assert (task_dir / "artifacts.yaml").is_file()
    assert task_status(db_path, "TASK-0001") == "result_attached"

    passed = runner.invoke(
        app,
        [
            "task",
            "verify",
            "TASK-0001",
            "--status",
            "passed",
            "--note",
            "manual verification",
        ],
    )
    assert passed.exit_code == 0, passed.output
    assert (task_dir / "verification_record.yaml").is_file()
    assert task_status(db_path, "TASK-0001") == "verified"


@pytest.mark.parametrize(
    ("verification_status", "expected_task_status"),
    [
        ("failed", "failed"),
        ("blocked", "blocked"),
    ],
)
def test_failed_and_blocked_verification_statuses(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    verification_status: str,
    expected_task_status: str,
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Verify this task"]).exit_code == 0

    verify = runner.invoke(
        app,
        [
            "task",
            "verify",
            "TASK-0001",
            "--status",
            verification_status,
            "--note",
            "manual verification",
        ],
    )

    assert verify.exit_code == 0, verify.output
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert task_status(db_path, "TASK-0001") == expected_task_status
