import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from projectops.cli import app
from projectops.json_io import CONTRACT_VERSION


runner = CliRunner()


def parse_json_output(result) -> dict:
    assert "Traceback" not in result.output
    return json.loads(result.output)


def test_status_json_before_init_is_valid_and_read_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["status", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["workspace_exists"] is False
    assert payload["workspace_path"] == str(tmp_path / ".projectops")
    assert payload["state_db_path"] is None
    assert payload["memory_path"] is None
    assert payload["task_count"] == 0
    assert payload["tasks"] == []
    assert not (tmp_path / ".projectops").exists()


def test_status_json_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["status", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["workspace_exists"] is True
    assert payload["workspace_path"] == str(tmp_path / ".projectops")
    assert payload["state_db_path"] == str(tmp_path / ".projectops" / "state.sqlite")
    assert payload["memory_path"] == str(tmp_path / ".projectops" / "memory")
    assert payload["task_count"] == 0
    assert payload["tasks"] == []


def test_status_json_after_creating_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "JSON status task"]).exit_code == 0

    result = runner.invoke(app, ["status", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["task_count"] == 1
    assert payload["tasks"][0]["id"] == "TASK-0001"
    assert payload["tasks"][0]["title"] == "JSON status task"
    assert payload["tasks"][0]["status"] == "draft"
    assert payload["tasks"][0]["created_at"]
    assert payload["tasks"][0]["updated_at"]


def test_task_list_json_fails_cleanly_before_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["task", "list", "--json"])

    assert result.exit_code != 0
    assert "ProjectOps workspace not found. Run `ops init` first." in result.output
    assert "Traceback" not in result.output


def test_task_list_json_after_init_with_no_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["task", "list", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload == {
        "contract_version": CONTRACT_VERSION,
        "tasks": [],
        "count": 0,
    }


def test_task_list_json_after_two_tasks_is_sorted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "First JSON task"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Second JSON task"]).exit_code == 0

    result = runner.invoke(app, ["task", "list", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["count"] == 2
    assert [task["id"] for task in payload["tasks"]] == ["TASK-0001", "TASK-0002"]
    assert [task["title"] for task in payload["tasks"]] == [
        "First JSON task",
        "Second JSON task",
    ]
    for task in payload["tasks"]:
        assert set(task) == {"id", "title", "status", "created_at", "updated_at"}
        assert task["status"] == "draft"
        assert task["created_at"]
        assert task["updated_at"]


def test_doctor_json_before_init_is_valid_and_read_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["doctor", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 1
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["healthy"] is False
    assert payload["error_count"] >= 1
    assert any(
        check["level"] == "error" and "workspace missing" in check["message"]
        for check in payload["checks"]
    )
    assert not (tmp_path / ".projectops").exists()


def test_doctor_json_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["doctor", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 0, result.output
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["healthy"] is True
    assert payload["error_count"] == 0
    assert payload["checks"]
    assert {"level", "name", "message", "path"} <= set(payload["checks"][0])


def test_doctor_json_reports_broken_workspace_without_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Broken JSON doctor"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    plan_path = tmp_path / ".projectops" / "tasks" / "TASK-0001" / "plan.yaml"
    plan_path.unlink()

    result = runner.invoke(app, ["doctor", "--json"])

    payload = parse_json_output(result)
    assert result.exit_code == 1
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["healthy"] is False
    assert payload["error_count"] >= 1
    assert any("plan.yaml" in check["message"] for check in payload["checks"])
    assert not plan_path.exists()


def test_human_outputs_remain_readable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    status = runner.invoke(app, ["status"])
    task_list = runner.invoke(app, ["task", "list"])
    doctor = runner.invoke(app, ["doctor"])

    assert status.exit_code == 0, status.output
    assert ".projectops exists: yes" in status.output
    assert task_list.exit_code == 0, task_list.output
    assert "No tasks found." in task_list.output
    assert doctor.exit_code == 0, doctor.output
    assert "OK" in doctor.output
    assert "Summary:" in doctor.output
