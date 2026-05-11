from weaveflow.models import ProjectConfig, TaskSpec, TaskStatus


def test_project_config_serializes_required_fields() -> None:
    config = ProjectConfig()
    data = config.model_dump(mode="json")

    assert data["name"] == "Weaveflow"
    assert data["version"] == 1
    assert data["created_at"]


def test_task_spec_defaults_are_human_readable() -> None:
    spec = TaskSpec(
        id="TASK-0001",
        title="Example task",
        user_request="Please structure this task.",
    )

    assert spec.status == TaskStatus.DRAFT
    assert spec.success_criteria == [
        "Task is understood and structured",
        "A plan can be generated",
        "A Codex worker brief can be generated",
    ]
    assert spec.constraints == [
        "Do not perform destructive operations without explicit approval",
        "Do not call external APIs in this MVP",
        "Do not make unrelated changes",
    ]
    assert spec.notes == []


def test_task_spec_serializes_defaults() -> None:
    spec = TaskSpec(
        id="TASK-0001",
        title="Example task",
        user_request="Please structure this task.",
    )
    data = spec.model_dump(mode="json")

    assert data["id"] == "TASK-0001"
    assert data["status"] == "draft"
    assert data["success_criteria"]
    assert data["constraints"]
