from pathlib import Path
import sqlite3

import pytest
from typer.testing import CliRunner

from projectops.cli import app
from projectops.yaml_io import read_yaml


runner = CliRunner()


def task_status(db_path: Path, task_id: str) -> str:
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT status FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    assert row is not None
    return str(row[0])


def assert_status(task_dir: Path, db_path: Path, expected: str) -> None:
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == expected
    assert task_status(db_path, "TASK-0001") == expected


def test_full_mvp_workflow_creates_report_and_memory_diff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert (
        runner.invoke(
            app,
            ["task", "create", "Investigate and fix a sample auth bug"],
        ).exit_code
        == 0
    )
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    assert (
        runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "codex"]).exit_code
        == 0
    )

    result_file = tmp_path / "codex_result.md"
    result_file.write_text("# Result\n\nImplemented and verified.\n", encoding="utf-8")
    assert (
        runner.invoke(
            app,
            ["task", "attach-result", "TASK-0001", str(result_file)],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            app,
            [
                "task",
                "verify",
                "TASK-0001",
                "--status",
                "passed",
                "--note",
                "Manual verification passed",
            ],
        ).exit_code
        == 0
    )

    report = runner.invoke(app, ["task", "report", "TASK-0001"])
    memory = runner.invoke(app, ["memory", "propose", "TASK-0001"])

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert report.exit_code == 0, report.output
    assert memory.exit_code == 0, memory.output
    assert (task_dir / "final_report.md").is_file()
    assert (task_dir / "memory_diff.md").is_file()
    assert "# Final Report: TASK-0001" in (task_dir / "final_report.md").read_text(
        encoding="utf-8"
    )
    memory_diff = (task_dir / "memory_diff.md").read_text(encoding="utf-8")
    assert "## Do Not Store" in memory_diff
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "completed"


def test_status_consistency_across_workflow_states(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Check status consistency"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert_status(task_dir, db_path, "draft")

    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    assert_status(task_dir, db_path, "planned")

    assert (
        runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "codex"]).exit_code
        == 0
    )
    assert_status(task_dir, db_path, "briefed")

    result_file = tmp_path / "result.md"
    result_file.write_text("# Result\n", encoding="utf-8")
    assert (
        runner.invoke(
            app,
            ["task", "attach-result", "TASK-0001", str(result_file)],
        ).exit_code
        == 0
    )
    assert_status(task_dir, db_path, "result_attached")

    assert (
        runner.invoke(
            app,
            [
                "task",
                "verify",
                "TASK-0001",
                "--status",
                "passed",
                "--note",
                "manual",
            ],
        ).exit_code
        == 0
    )
    assert_status(task_dir, db_path, "verified")

    assert runner.invoke(app, ["task", "report", "TASK-0001"]).exit_code == 0
    assert_status(task_dir, db_path, "completed")


@pytest.mark.parametrize("verification_status", ["failed", "blocked"])
def test_status_consistency_for_failed_and_blocked_verification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, verification_status: str
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Check terminal status"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    result = runner.invoke(
        app,
        [
            "task",
            "verify",
            "TASK-0001",
            "--status",
            verification_status,
            "--note",
            "manual",
        ],
    )

    assert result.exit_code == 0, result.output
    assert_status(task_dir, db_path, verification_status)


def test_safe_reruns_do_not_duplicate_or_corrupt_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Rerun generated commands"]).exit_code == 0

    for _ in range(2):
        assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert_status(task_dir, db_path, "planned")

    for _ in range(2):
        result = runner.invoke(app, ["task", "brief", "TASK-0001", "--worker", "codex"])
        assert result.exit_code == 0, result.output
    assert_status(task_dir, db_path, "briefed")

    for _ in range(2):
        report = runner.invoke(app, ["task", "report", "TASK-0001"])
        memory = runner.invoke(app, ["memory", "propose", "TASK-0001"])
        assert report.exit_code == 0, report.output
        assert memory.exit_code == 0, memory.output

    with sqlite3.connect(db_path) as connection:
        row_count = connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    assert row_count == 1
    assert (task_dir / "plan.yaml").is_file()
    assert (task_dir / "worker_brief_codex.md").is_file()
    assert (task_dir / "final_report.md").is_file()
    assert (task_dir / "memory_diff.md").is_file()
