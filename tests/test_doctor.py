import shutil
import sqlite3
from pathlib import Path

import pytest
from typer.testing import CliRunner

from weaveflow.cli import app


runner = CliRunner()


def task_dir(root: Path, task_id: str = "TASK-0001") -> Path:
    return root / ".weaveflow" / "tasks" / task_id


def update_sqlite_status(root: Path, task_id: str, status: str) -> None:
    with sqlite3.connect(root / ".weaveflow" / "state.sqlite") as connection:
        connection.execute(
            "UPDATE tasks SET status = ? WHERE id = ?",
            (status, task_id),
        )
        connection.commit()


def create_result_file(root: Path) -> Path:
    result_path = root / "result.md"
    result_path.write_text("# Result\n\nDone.\n", encoding="utf-8")
    return result_path


def create_completed_task(root: Path) -> None:
    assert runner.invoke(app, ["task", "create", "Complete this task"]).exit_code == 0
    result_path = create_result_file(root)
    assert (
        runner.invoke(
            app,
            ["task", "attach-result", "TASK-0001", str(result_path)],
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
                "manual verification",
            ],
        ).exit_code
        == 0
    )
    assert runner.invoke(app, ["task", "report", "TASK-0001"]).exit_code == 0
    assert runner.invoke(app, ["memory", "propose", "TASK-0001"]).exit_code == 0


def test_doctor_fails_cleanly_before_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "workspace missing" in result.output
    assert "Run `weaveflow init` first" in result.output
    assert "ERROR: 1" in result.output
    assert not (tmp_path / ".weaveflow").exists()


def test_doctor_passes_after_init_with_no_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "OK" in result.output
    assert "workspace exists" in result.output
    assert "SQLite tasks table exists" in result.output
    assert "ERROR: 0" in result.output


def test_doctor_passes_after_creating_draft_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Draft task"]).exit_code == 0

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "TASK-0001 task_spec.yaml exists" in result.output
    assert "TASK-0001 artifacts/ exists" in result.output
    assert "ERROR: 0" in result.output


def test_doctor_detects_missing_required_workspace_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    (tmp_path / ".weaveflow" / "config.yaml").unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "ERROR" in result.output
    assert "config.yaml" in result.output


def test_doctor_detects_missing_task_spec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Missing spec"]).exit_code == 0
    (task_dir(tmp_path) / "task_spec.yaml").unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 task_spec.yaml missing" in result.output


def test_doctor_detects_missing_plan_for_planned_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Missing plan"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    plan_path = task_dir(tmp_path) / "plan.yaml"
    plan_path.unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 plan.yaml missing for status planned" in result.output


def test_doctor_detects_missing_worker_brief_for_briefed_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Missing brief"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    assert runner.invoke(app, ["task", "brief", "TASK-0001"]).exit_code == 0
    (task_dir(tmp_path) / "worker_brief_codex.md").unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 worker_brief_codex.md missing for status briefed" in result.output


def test_doctor_detects_sqlite_and_yaml_status_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Mismatch status"]).exit_code == 0
    update_sqlite_status(tmp_path, "TASK-0001", "planned")

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 SQLite status (planned) does not match" in result.output


def test_doctor_detects_task_directory_not_indexed_in_sqlite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    unindexed_dir = tmp_path / ".weaveflow" / "tasks" / "TASK-9999"
    unindexed_dir.mkdir()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-9999 task directory is not indexed in SQLite" in result.output


def test_doctor_detects_sqlite_row_pointing_to_missing_task_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Missing task dir"]).exit_code == 0
    shutil.rmtree(task_dir(tmp_path))

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 task directory missing" in result.output


def test_doctor_detects_missing_artifact_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Missing artifact"]).exit_code == 0
    result_path = create_result_file(tmp_path)
    assert (
        runner.invoke(
            app,
            ["task", "attach-result", "TASK-0001", str(result_path)],
        ).exit_code
        == 0
    )
    (task_dir(tmp_path) / "artifacts" / "result.md").unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 artifact file missing: artifacts/result.md" in result.output


def test_doctor_warns_for_completed_task_missing_memory_diff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    create_completed_task(tmp_path)
    (task_dir(tmp_path) / "memory_diff.md").unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "WARN" in result.output
    assert "TASK-0001 memory_diff.md not found after completed task" in result.output
    assert "ERROR: 0" in result.output


def test_doctor_is_read_only_and_does_not_recreate_missing_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Read only doctor"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    plan_path = task_dir(tmp_path) / "plan.yaml"
    plan_path.unlink()

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "TASK-0001 plan.yaml missing for status planned" in result.output
    assert not plan_path.exists()
