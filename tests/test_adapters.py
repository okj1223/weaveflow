import json
from pathlib import Path

from projectops.adapters import (
    AdapterRequest,
    AdapterResponse,
    ProjectOpsServiceAdapter,
)
from projectops.json_io import CONTRACT_VERSION
from projectops.yaml_io import read_yaml


def assert_json_serializable(response: AdapterResponse) -> None:
    json.dumps(response.model_dump(mode="json"))


def test_adapter_imports() -> None:
    assert AdapterRequest(action="status").action == "status"
    assert AdapterResponse(
        ok=True,
        action="status",
        message="ok",
        data={},
        error_type=None,
        error_message=None,
        read_only=True,
    ).ok
    assert ProjectOpsServiceAdapter(Path("."))


def test_status_before_init_is_read_only_success(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(AdapterRequest(action="status"))

    assert response.ok is True
    assert response.contract_version == CONTRACT_VERSION
    assert response.read_only is True
    assert response.data is not None
    assert response.data["workspace_exists"] is False
    assert_json_serializable(response)


def test_doctor_before_init_is_read_only_and_does_not_create_workspace(
    tmp_path: Path,
) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(AdapterRequest(action="doctor"))

    assert response.ok is True
    assert response.data is not None
    assert response.data["healthy"] is False
    assert response.data["error_count"] >= 1
    assert not (tmp_path / ".projectops").exists()
    assert_json_serializable(response)


def test_list_tasks_before_init_returns_clean_projectops_error(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(AdapterRequest(action="list_tasks"))

    assert response.ok is False
    assert response.error_type == "WorkspaceNotFoundError"
    assert response.error_message is not None
    assert "Traceback" not in response.error_message
    assert not (tmp_path / ".projectops").exists()
    assert_json_serializable(response)


def test_mutating_action_without_allow_mutation_is_denied(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(AdapterRequest(action="init_workspace"))

    assert response.ok is False
    assert response.error_type == "MutationNotAllowed"
    assert not (tmp_path / ".projectops").exists()
    assert_json_serializable(response)


def test_init_workspace_with_mutation_allowed(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(
        AdapterRequest(action="init_workspace", allow_mutation=True)
    )

    assert response.ok is True
    assert response.data is not None
    assert response.data["name"] == "ProjectOps Kernel"
    assert (tmp_path / ".projectops").is_dir()
    assert_json_serializable(response)


def test_create_task_with_mutation_allowed(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))

    response = adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Adapter task"},
            allow_mutation=True,
        )
    )

    assert response.ok is True
    assert response.data is not None
    assert response.data["id"] == "TASK-0001"
    assert (
        tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()
    assert_json_serializable(response)


def test_create_plan_and_worker_brief(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Plan and brief"},
            allow_mutation=True,
        )
    )

    plan_response = adapter.handle(
        AdapterRequest(
            action="create_plan",
            params={"task_id": "TASK-0001"},
            allow_mutation=True,
        )
    )
    brief_response = adapter.handle(
        AdapterRequest(
            action="create_worker_brief",
            params={"task_id": "TASK-0001", "worker": "codex"},
            allow_mutation=True,
        )
    )

    task_dir = tmp_path / ".projectops" / "tasks" / "TASK-0001"
    assert plan_response.ok is True
    assert brief_response.ok is True
    assert (task_dir / "plan.yaml").is_file()
    assert (task_dir / "worker_brief_codex.md").is_file()
    assert_json_serializable(plan_response)
    assert_json_serializable(brief_response)


def test_show_task_is_read_only(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Show this task"},
            allow_mutation=True,
        )
    )

    response = adapter.handle(
        AdapterRequest(action="show_task", params={"task_id": "TASK-0001"})
    )

    assert response.ok is True
    assert response.read_only is True
    assert response.data is not None
    assert response.data["id"] == "TASK-0001"
    assert response.data["user_request"] == "Show this task"
    assert_json_serializable(response)


def test_attach_result_missing_file_returns_error_without_status_change(
    tmp_path: Path,
) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Missing artifact"},
            allow_mutation=True,
        )
    )
    task_spec_path = tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"

    response = adapter.handle(
        AdapterRequest(
            action="attach_result",
            params={"task_id": "TASK-0001", "result_path": "missing.md"},
            allow_mutation=True,
        )
    )

    assert response.ok is False
    assert response.error_type == "MissingResultFileError"
    assert read_yaml(task_spec_path)["status"] == "draft"
    assert_json_serializable(response)


def test_verify_invalid_status_returns_error(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Invalid status"},
            allow_mutation=True,
        )
    )

    response = adapter.handle(
        AdapterRequest(
            action="verify_task",
            params={"task_id": "TASK-0001", "status": "invalid", "note": "nope"},
            allow_mutation=True,
        )
    )

    assert response.ok is False
    assert response.error_type == "InvalidVerificationStatusError"
    assert_json_serializable(response)


def test_full_adapter_workflow(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    responses = [
        adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True)),
        adapter.handle(
            AdapterRequest(
                action="create_task",
                params={"user_request": "Full adapter workflow"},
                allow_mutation=True,
            )
        ),
        adapter.handle(
            AdapterRequest(
                action="create_plan",
                params={"task_id": "TASK-0001"},
                allow_mutation=True,
            )
        ),
        adapter.handle(
            AdapterRequest(
                action="create_worker_brief",
                params={"task_id": "TASK-0001"},
                allow_mutation=True,
            )
        ),
    ]
    result_path = tmp_path / "result.md"
    result_path.write_text("# Result\n\nDone.\n", encoding="utf-8")
    responses.extend(
        [
            adapter.handle(
                AdapterRequest(
                    action="attach_result",
                    params={"task_id": "TASK-0001", "result_path": str(result_path)},
                    allow_mutation=True,
                )
            ),
            adapter.handle(
                AdapterRequest(
                    action="verify_task",
                    params={
                        "task_id": "TASK-0001",
                        "status": "passed",
                        "note": "manual verification passed",
                    },
                    allow_mutation=True,
                )
            ),
            adapter.handle(
                AdapterRequest(
                    action="create_final_report",
                    params={"task_id": "TASK-0001"},
                    allow_mutation=True,
                )
            ),
            adapter.handle(
                AdapterRequest(
                    action="propose_memory_update",
                    params={"task_id": "TASK-0001"},
                    allow_mutation=True,
                )
            ),
            adapter.handle(AdapterRequest(action="list_tasks")),
            adapter.handle(AdapterRequest(action="doctor")),
        ]
    )

    assert all(response.ok for response in responses)
    for response in responses:
        assert_json_serializable(response)

    list_response = responses[-2]
    doctor_response = responses[-1]
    assert list_response.data is not None
    assert list_response.data["tasks"][0]["status"] == "completed"
    assert doctor_response.data is not None
    assert doctor_response.data["healthy"] is True


def test_unsupported_action_returns_error(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)

    response = adapter.handle(AdapterRequest(action="does_not_exist"))

    assert response.ok is False
    assert response.error_type == "UnsupportedAction"
    assert response.error_message == "Unsupported adapter action: does_not_exist"
    assert_json_serializable(response)


def test_missing_required_param_returns_error(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))

    response = adapter.handle(
        AdapterRequest(action="create_task", allow_mutation=True)
    )

    assert response.ok is False
    assert response.error_type == "InvalidAdapterRequest"
    assert response.error_message is not None
    assert "user_request" in response.error_message
    assert_json_serializable(response)
