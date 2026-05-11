import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError
from typer.testing import CliRunner

from weaveflow.cli import app
from weaveflow.json_io import CONTRACT_VERSION


runner = CliRunner()
REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = REPO_ROOT / "schemas"


def load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def parse_json_output(result) -> dict:
    assert "Traceback" not in result.output
    return json.loads(result.output)


def validate_with_schema(payload: dict, schema_name: str) -> None:
    schema = load_schema(schema_name)
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(payload)


def assert_contract_version(payload: dict) -> None:
    assert payload["contract_version"] == CONTRACT_VERSION


def assert_task_shape(task: dict) -> None:
    assert {"id", "title", "status", "created_at", "updated_at"} <= set(task)
    assert task["id"].startswith("TASK-")
    assert task["title"]
    assert task["status"]
    assert task["created_at"]
    assert task["updated_at"]


def test_schema_files_are_valid_json_schemas() -> None:
    for schema_name in [
        "status.schema.json",
        "task_list.schema.json",
        "doctor.schema.json",
    ]:
        schema = load_schema(schema_name)
        Draft202012Validator.check_schema(schema)


def test_schemas_require_contract_version() -> None:
    payloads = {
        "status.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "workspace_exists": False,
            "workspace_path": "/tmp/project/.weaveflow",
            "state_db_path": None,
            "memory_path": None,
            "task_count": 0,
            "tasks": [],
        },
        "task_list.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "tasks": [],
            "count": 0,
        },
        "doctor.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "healthy": False,
            "ok_count": 0,
            "warn_count": 0,
            "error_count": 1,
            "checks": [
                {
                    "level": "error",
                    "name": "workspace_exists",
                    "message": "workspace missing",
                    "path": ".weaveflow",
                }
            ],
        },
    }

    for schema_name, payload in payloads.items():
        schema = load_schema(schema_name)
        invalid_payload = dict(payload)
        invalid_payload.pop("contract_version")
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate(invalid_payload)


def test_schemas_reject_wrong_contract_version() -> None:
    payloads = {
        "status.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "workspace_exists": False,
            "workspace_path": "/tmp/project/.weaveflow",
            "state_db_path": None,
            "memory_path": None,
            "task_count": 0,
            "tasks": [],
        },
        "task_list.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "tasks": [],
            "count": 0,
        },
        "doctor.schema.json": {
            "contract_version": CONTRACT_VERSION,
            "healthy": True,
            "ok_count": 1,
            "warn_count": 0,
            "error_count": 0,
            "checks": [
                {
                    "level": "ok",
                    "name": "workspace_exists",
                    "message": "workspace exists",
                    "path": ".weaveflow",
                }
            ],
        },
    }

    for schema_name, payload in payloads.items():
        schema = load_schema(schema_name)
        invalid_payload = {**payload, "contract_version": "weaveflow.v2"}
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate(invalid_payload)


def test_status_json_contract_before_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["status", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "status.schema.json")
    assert_contract_version(payload)
    assert payload["workspace_exists"] is False
    assert payload["task_count"] == 0
    assert payload["tasks"] == []
    assert not (tmp_path / ".weaveflow").exists()


def test_status_json_contract_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["status", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "status.schema.json")
    assert_contract_version(payload)
    assert payload["workspace_exists"] is True
    assert payload["task_count"] == 0


def test_status_json_contract_after_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "First schema task"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Second schema task"]).exit_code == 0

    result = runner.invoke(app, ["status", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "status.schema.json")
    assert_contract_version(payload)
    assert payload["task_count"] == 2
    assert len(payload["tasks"]) == 2
    for task in payload["tasks"]:
        assert_task_shape(task)


def test_task_list_json_contract_after_init_with_no_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["task", "list", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "task_list.schema.json")
    assert_contract_version(payload)
    assert payload["count"] == 0
    assert payload["tasks"] == []


def test_task_list_json_contract_after_two_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "First listed task"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Second listed task"]).exit_code == 0

    result = runner.invoke(app, ["task", "list", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "task_list.schema.json")
    assert_contract_version(payload)
    assert payload["count"] == 2
    assert len(payload["tasks"]) == 2
    assert payload["count"] == len(payload["tasks"])
    assert [task["id"] for task in payload["tasks"]] == ["TASK-0001", "TASK-0002"]
    for task in payload["tasks"]:
        assert_task_shape(task)


def test_doctor_json_contract_before_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["doctor", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 1
    validate_with_schema(payload, "doctor.schema.json")
    assert_contract_version(payload)
    assert payload["healthy"] is False
    assert payload["error_count"] >= 1
    assert any(
        check["level"] == "error" and "workspace missing" in check["message"]
        for check in payload["checks"]
    )
    assert not (tmp_path / ".weaveflow").exists()


def test_doctor_json_contract_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0

    result = runner.invoke(app, ["doctor", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 0, result.output
    validate_with_schema(payload, "doctor.schema.json")
    assert_contract_version(payload)
    assert payload["healthy"] is True
    assert payload["error_count"] == 0


def test_doctor_json_contract_with_broken_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["init"]).exit_code == 0
    assert runner.invoke(app, ["task", "create", "Broken schema doctor"]).exit_code == 0
    assert runner.invoke(app, ["task", "plan", "TASK-0001"]).exit_code == 0
    plan_path = tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "plan.yaml"
    plan_path.unlink()

    result = runner.invoke(app, ["doctor", "--json"])
    payload = parse_json_output(result)

    assert result.exit_code == 1
    validate_with_schema(payload, "doctor.schema.json")
    assert_contract_version(payload)
    assert payload["healthy"] is False
    assert payload["error_count"] >= 1
    assert any("plan.yaml" in check["message"] for check in payload["checks"])
    assert not plan_path.exists()
