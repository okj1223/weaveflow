import sqlite3
from pathlib import Path

import pytest
from typer.testing import CliRunner

from projectops.cli import app
from projectops.store import count_tasks
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


def test_init_creates_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["init"])

    assert result.exit_code == 0, result.output
    workspace = tmp_path / ".projectops"
    assert (workspace / "config.yaml").is_file()
    assert (workspace / "state.sqlite").is_file()
    assert (workspace / "memory" / "project.md").is_file()
    assert (workspace / "memory" / "preferences.yaml").is_file()
    assert (workspace / "memory" / "decisions").is_dir()
    assert (workspace / "tasks").is_dir()
    assert count_tasks(workspace / "state.sqlite") == 0

    with sqlite3.connect(workspace / "state.sqlite") as connection:
        columns = connection.execute("PRAGMA table_info(tasks)").fetchall()

    assert [column[1] for column in columns] == [
        "id",
        "title",
        "status",
        "created_at",
        "updated_at",
        "task_dir",
    ]


def test_status_reports_workspace_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    init_result = runner.invoke(app, ["init"])
    assert init_result.exit_code == 0, init_result.output

    result = runner.invoke(app, ["status"])

    assert result.exit_code == 0, result.output
    assert ".projectops exists: yes" in result.output
    assert f"workspace: {tmp_path / '.projectops'}" in result.output
    assert "tasks: 0" in result.output
    assert f"state.sqlite: {tmp_path / '.projectops' / 'state.sqlite'}" in result.output
    assert f"memory: {tmp_path / '.projectops' / 'memory'}" in result.output


def test_init_is_safe_to_rerun(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    first_init = runner.invoke(app, ["init"])
    assert first_init.exit_code == 0, first_init.output
    create = runner.invoke(app, ["task", "create", "Preserve this task"])
    assert create.exit_code == 0, create.output

    second_init = runner.invoke(app, ["init"])

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert second_init.exit_code == 0, second_init.output
    assert "ProjectOps workspace already exists" in second_init.output
    assert task_dir.is_dir()
    assert (task_dir / "task_spec.yaml").is_file()
    assert count_tasks(tmp_path / ".projectops" / "state.sqlite") == 1

    status = runner.invoke(app, ["status"])
    assert status.exit_code == 0, status.output
    assert "task statuses:" in status.output
    assert "- TASK-0001: draft" in status.output


def test_task_create_allocates_ids_and_writes_task_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    first = runner.invoke(app, ["task", "create", "Investigate auth bug"])
    second = runner.invoke(app, ["task", "create", "Write release notes"])

    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output
    assert "Created task: TASK-0001" in first.output
    assert "Created task: TASK-0002" in second.output

    first_task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert (first_task_dir / "task_spec.yaml").is_file()
    assert (first_task_dir / "artifacts").is_dir()

    spec = read_yaml(first_task_dir / "task_spec.yaml")
    assert spec["id"] == "TASK-0001"
    assert spec["title"] == "Investigate auth bug"
    assert spec["status"] == "draft"
    assert spec["constraints"] == [
        "Do not perform destructive operations without explicit approval",
        "Do not call external APIs in this MVP",
        "Do not make unrelated changes",
    ]

    with sqlite3.connect(tmp_path / ".projectops" / "state.sqlite") as connection:
        row = connection.execute(
            "SELECT id, title, status, task_dir FROM tasks WHERE id = ?",
            ("TASK-0001",),
        ).fetchone()

    assert row == (
        "TASK-0001",
        "Investigate auth bug",
        "draft",
        str(first_task_dir),
    )


def test_task_show_loads_task_spec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    create_result = runner.invoke(
        app,
        ["task", "create", "Investigate and fix a sample auth bug"],
    )
    assert create_result.exit_code == 0, create_result.output

    result = runner.invoke(app, ["task", "show", "TASK-0001"])

    assert result.exit_code == 0, result.output
    assert "id: TASK-0001" in result.output
    assert "title: Investigate and fix a sample auth bug" in result.output
    assert "status: draft" in result.output
    assert "user_request: Investigate and fix a sample auth bug" in result.output
    assert "success_criteria:" in result.output
    assert "- Task is understood and structured" in result.output
    assert "constraints:" in result.output
    assert "- Do not call external APIs in this MVP" in result.output
    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert f"task directory: {task_dir}" in result.output


def test_task_list_shows_all_tasks_sorted_by_created_at(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    first = runner.invoke(app, ["task", "create", "Investigate auth bug"])
    second = runner.invoke(app, ["task", "create", "Write release notes"])
    assert first.exit_code == 0, first.output
    assert second.exit_code == 0, second.output

    result = runner.invoke(app, ["task", "list"])

    assert result.exit_code == 0, result.output
    lines = result.output.strip().splitlines()
    assert len(lines) == 2
    first_columns = lines[0].split(" | ")
    second_columns = lines[1].split(" | ")
    assert first_columns[:3] == ["TASK-0001", "draft", "Investigate auth bug"]
    assert second_columns[:3] == ["TASK-0002", "draft", "Write release notes"]
    assert len(first_columns) == 5
    assert len(second_columns) == 5
    assert first_columns[3]
    assert first_columns[4]
    assert second_columns[3]
    assert second_columns[4]


def test_task_plan_generates_default_plan_and_updates_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Investigate auth bug"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"
    assert task_status(db_path, "TASK-0001") == "draft"

    result = runner.invoke(app, ["task", "plan", "TASK-0001"])

    assert result.exit_code == 0, result.output
    assert f"Plan: {task_dir / 'plan.yaml'}" in result.output
    plan = read_yaml(task_dir / "plan.yaml")
    assert plan["task_id"] == "TASK-0001"
    assert len(plan["nodes"]) == 4
    assert [(node["id"], node["type"]) for node in plan["nodes"]] == [
        ("intake_review", "intake"),
        ("implementation_or_investigation", "execution"),
        ("verification", "verification"),
        ("reporting", "reporting"),
    ]
    assert [node["expected_output"] for node in plan["nodes"]] == [
        "Clarified assumptions and scope",
        "Result artifact or code change summary",
        "Verification evidence",
        "Final result summary",
    ]
    assert [node["id"] for node in plan["nodes"]] == [
        "intake_review",
        "implementation_or_investigation",
        "verification",
        "reporting",
    ]
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "planned"
    assert task_status(db_path, "TASK-0001") == "planned"


def test_task_brief_generates_codex_brief_and_updates_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    create_result = runner.invoke(
        app,
        ["task", "create", "Investigate and fix a sample auth bug"],
    )
    assert create_result.exit_code == 0, create_result.output

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "draft"
    assert task_status(db_path, "TASK-0001") == "draft"

    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "planned"
    assert task_status(db_path, "TASK-0001") == "planned"

    result = runner.invoke(
        app,
        ["task", "brief", "TASK-0001", "--worker", "codex"],
    )

    assert result.exit_code == 0, result.output
    brief_path = task_dir / "worker_brief_codex.md"
    assert f"Brief: {brief_path}" in result.output
    assert brief_path.is_file()

    brief = brief_path.read_text(encoding="utf-8")
    assert "Task ID: TASK-0001" in brief
    assert "Investigate and fix a sample auth bug" in brief
    assert "## Plan Nodes" in brief
    assert "intake_review" in brief
    assert "Do not make unrelated changes." in brief
    assert "Commands run" in brief
    assert "Tests passed, failed, or not run" in brief
    assert "list every changed file" in brief
    assert "Remaining risks" in brief
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "briefed"
    assert task_status(db_path, "TASK-0001") == "briefed"


def test_task_attach_result_copies_file_and_registers_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Investigate auth bug"]).exit_code == 0

    source = tmp_path / "result.md"
    source.write_text("# Result\n\nAuth bug fixed.\n", encoding="utf-8")
    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"

    result = runner.invoke(
        app,
        ["task", "attach-result", "TASK-0001", str(source)],
    )

    copied = task_dir / "artifacts" / "result.md"
    assert result.exit_code == 0, result.output
    assert f"Artifact: {copied}" in result.output
    assert copied.read_text(encoding="utf-8") == "# Result\n\nAuth bug fixed.\n"

    artifacts = read_yaml(task_dir / "artifacts.yaml")
    assert artifacts["artifacts"][0]["id"] == "ARTIFACT-0001"
    assert artifacts["artifacts"][0]["task_id"] == "TASK-0001"
    assert artifacts["artifacts"][0]["type"] == "result"
    assert artifacts["artifacts"][0]["path"] == "artifacts/result.md"
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "result_attached"
    assert task_status(db_path, "TASK-0001") == "result_attached"


def test_task_verify_passed_creates_record_and_marks_verified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Investigate auth bug"]).exit_code == 0

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    result = runner.invoke(
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

    record_path = task_dir / "verification_record.yaml"
    assert result.exit_code == 0, result.output
    assert f"Verification: {record_path}" in result.output
    assert record_path.is_file()

    record = read_yaml(record_path)
    assert record["task_id"] == "TASK-0001"
    assert record["status"] == "passed"
    assert record["commands"] == [
        {
            "command": "manual",
            "status": "passed",
            "note": "manual verification",
        }
    ]
    assert record["notes"] == ["manual verification"]
    assert record["remaining_risks"] == []
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "verified"
    assert task_status(db_path, "TASK-0001") == "verified"


@pytest.mark.parametrize(
    ("verification_status", "task_status_value"),
    [
        ("failed", "failed"),
        ("blocked", "blocked"),
    ],
)
def test_task_verify_failed_and_blocked_statuses(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    verification_status: str,
    task_status_value: str,
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Investigate auth bug"]).exit_code == 0

    result = runner.invoke(
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

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert result.exit_code == 0, result.output
    record = read_yaml(task_dir / "verification_record.yaml")
    assert record["status"] == verification_status
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == task_status_value
    assert task_status(db_path, "TASK-0001") == task_status_value


def test_task_report_generates_report_and_completes_verified_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    create_result = runner.invoke(
        app,
        ["task", "create", "Investigate and fix a sample auth bug"],
    )
    assert create_result.exit_code == 0, create_result.output
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
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

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    db_path = tmp_path / ".projectops" / "state.sqlite"
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "verified"

    result = runner.invoke(app, ["task", "report", "TASK-0001"])

    report_path = task_dir / "final_report.md"
    assert result.exit_code == 0, result.output
    assert f"Final report: {report_path}" in result.output
    assert report_path.is_file()

    report = report_path.read_text(encoding="utf-8")
    assert "# Final Report: TASK-0001" in report
    assert "Investigate and fix a sample auth bug" in report
    assert "## User Request" in report
    assert read_yaml(task_dir / "task_spec.yaml")["status"] == "completed"
    assert task_status(db_path, "TASK-0001") == "completed"


def test_memory_propose_generates_conservative_memory_diff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    create_result = runner.invoke(
        app,
        ["task", "create", "Investigate and fix a sample auth bug"],
    )
    assert create_result.exit_code == 0, create_result.output
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

    result = runner.invoke(app, ["memory", "propose", "TASK-0001"])

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    diff_path = task_dir / "memory_diff.md"
    assert result.exit_code == 0, result.output
    assert f"Memory diff: {diff_path}" in result.output
    assert diff_path.is_file()

    diff = diff_path.read_text(encoding="utf-8")
    assert "# Proposed Memory Update: TASK-0001" in diff
    assert "This is only a proposal" in diff
    assert "## Do Not Store" in diff
    assert "Secrets, credentials, tokens, or private keys." in diff
    assert "Unverified guesses or assumptions." in diff
