from pathlib import Path

import pytest

from projectops import service
from projectops.errors import (
    InvalidVerificationStatusError,
    MissingPlanError,
    MissingResultFileError,
    ProjectOpsError,
    TaskNotFoundError,
    UnsupportedWorkerError,
    WorkspaceNotFoundError,
)
from projectops.models import TaskStatus
from projectops.yaml_io import read_yaml


def test_service_end_to_end_workflow(tmp_path: Path) -> None:
    config = service.init_workspace(tmp_path)
    assert config.version == 1

    status = service.get_status(tmp_path)
    assert status["workspace_exists"] is True
    assert status["task_count"] == 0
    assert status["state_path"] == tmp_path / ".projectops" / "state.sqlite"
    assert status["workspace_path"] == tmp_path / ".projectops"
    assert status["tasks"] == []

    spec = service.create_task(tmp_path, "Test service boundary")
    assert spec.id == "TASK-0001"
    assert spec.status == TaskStatus.DRAFT

    shown = service.show_task(tmp_path, "TASK-0001")
    assert shown.user_request == "Test service boundary"

    plan = service.create_plan(tmp_path, "TASK-0001")
    assert plan.task_id == "TASK-0001"
    assert len(plan.nodes) == 4

    brief_path = service.create_worker_brief(tmp_path, "TASK-0001")
    expected_brief_path = (
        tmp_path
        / ".projectops"
        / "tasks"
        / "TASK-0001"
        / "worker_brief_codex.md"
    )
    assert brief_path == expected_brief_path
    assert brief_path.is_file()

    result_path = tmp_path / "result.md"
    result_path.write_text("# Result\n\nDone.\n", encoding="utf-8")
    artifact = service.attach_result(tmp_path, "TASK-0001", result_path)
    assert artifact.path == "artifacts/result.md"

    record = service.verify_task(
        tmp_path,
        "TASK-0001",
        status="passed",
        note="manual check passed",
    )
    assert record.status == "passed"

    report_path = service.create_final_report(tmp_path, "TASK-0001")
    assert report_path.is_file()

    memory_diff_path = service.propose_memory_update(tmp_path, "TASK-0001")
    assert memory_diff_path.is_file()

    tasks = service.list_tasks(tmp_path)
    assert len(tasks) == 1
    assert tasks[0].id == "TASK-0001"
    assert tasks[0].title == "Test service boundary"
    assert tasks[0].status == "completed"
    expected_task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"

    doctor = service.doctor_workspace(tmp_path)
    assert doctor.healthy is True
    assert doctor.error_count == 0

    task_spec = read_yaml(expected_task_dir / "task_spec.yaml")
    assert task_spec["status"] == "completed"


def test_service_functions_use_explicit_root_not_current_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    explicit_root = tmp_path / "explicit-root"
    current_directory = tmp_path / "current-directory"
    explicit_root.mkdir()
    current_directory.mkdir()
    monkeypatch.chdir(current_directory)

    service.init_workspace(explicit_root)
    spec = service.create_task(explicit_root, "Use explicit root")

    assert spec.id == "TASK-0001"
    assert (explicit_root / ".projectops" / "tasks" / "TASK-0001").is_dir()
    assert not (current_directory / ".projectops").exists()


def test_service_requires_workspace_for_task_creation(tmp_path: Path) -> None:
    with pytest.raises(WorkspaceNotFoundError):
        service.create_task(tmp_path, "Missing workspace")


def test_service_missing_task_error(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)

    with pytest.raises(TaskNotFoundError):
        service.show_task(tmp_path, "TASK-9999")


def test_service_missing_plan_error(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)
    service.create_task(tmp_path, "Needs a plan")

    with pytest.raises(MissingPlanError):
        service.create_worker_brief(tmp_path, "TASK-0001")


def test_service_unsupported_worker_error(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)
    service.create_task(tmp_path, "Unsupported worker")
    service.create_plan(tmp_path, "TASK-0001")

    with pytest.raises(UnsupportedWorkerError):
        service.create_worker_brief(
            tmp_path,
            "TASK-0001",
            worker="unsupported_worker",
        )


def test_service_invalid_verification_status_error(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)
    service.create_task(tmp_path, "Invalid verification")

    with pytest.raises(InvalidVerificationStatusError):
        service.verify_task(
            tmp_path,
            "TASK-0001",
            status="invalid",
            note="should fail",
        )


def test_service_missing_result_file_preserves_task_status(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)
    service.create_task(tmp_path, "Missing result")
    task_spec_path = tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"

    with pytest.raises(MissingResultFileError):
        service.attach_result(tmp_path, "TASK-0001", Path("missing.md"))

    assert read_yaml(task_spec_path)["status"] == "draft"


def test_service_errors_share_projectops_base_class(tmp_path: Path) -> None:
    with pytest.raises(ProjectOpsError):
        service.create_task(tmp_path, "Missing workspace")


def test_doctor_service_is_read_only_for_broken_workspace(tmp_path: Path) -> None:
    service.init_workspace(tmp_path)
    service.create_task(tmp_path, "Doctor read-only")
    service.create_plan(tmp_path, "TASK-0001")
    plan_path = tmp_path / ".projectops" / "tasks" / "TASK-0001" / "plan.yaml"
    plan_path.unlink()

    report = service.doctor_workspace(tmp_path)

    assert report.healthy is False
    assert any(
        check.level == "error"
        and "TASK-0001 plan.yaml missing for status planned" in check.message
        for check in report.checks
    )
    assert not plan_path.exists()
