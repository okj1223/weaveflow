import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from weaveflow.adapters import AdapterRequest, AdapterResponse, WeaveflowServiceAdapter
from weaveflow.json_io import CONTRACT_VERSION
from weaveflow.yaml_io import read_yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "schemas" / "adapter_response.schema.json"
REQUIRED_FIELDS = [
    "contract_version",
    "ok",
    "action",
    "message",
    "data",
    "error_type",
    "error_message",
    "read_only",
    "request_id",
]


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def response_payload(response: AdapterResponse) -> dict:
    payload = response.model_dump(mode="json")
    json.dumps(payload)
    return payload


def validate_response(response: AdapterResponse) -> dict:
    payload = response_payload(response)
    Draft202012Validator(load_schema()).validate(payload)
    assert payload["contract_version"] == CONTRACT_VERSION
    assert payload["message"]
    if payload["ok"]:
        assert payload["error_type"] is None
        assert payload["error_message"] is None
    else:
        assert isinstance(payload["error_type"], str)
        assert payload["error_type"]
        assert isinstance(payload["error_message"], str)
        assert payload["error_message"]
        assert payload["data"] is None
    return payload


def valid_payload() -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "ok": True,
        "action": "status",
        "message": "Adapter action succeeded: status",
        "data": {},
        "error_type": None,
        "error_message": None,
        "read_only": True,
        "request_id": None,
    }


def test_adapter_response_schema_file_is_valid() -> None:
    assert SCHEMA_PATH.exists()
    schema = load_schema()
    Draft202012Validator.check_schema(schema)


def test_status_response_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(AdapterRequest(action="status"))

    payload = validate_response(response)

    assert payload["ok"] is True
    assert payload["read_only"] is True
    assert payload["data"]["workspace_exists"] is False


def test_doctor_response_before_init_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(AdapterRequest(action="doctor"))

    payload = validate_response(response)

    assert payload["ok"] is True
    assert payload["read_only"] is True
    assert payload["data"]["healthy"] is False
    assert not (tmp_path / ".weaveflow").exists()


def test_list_tasks_before_init_error_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(
        AdapterRequest(action="list_tasks")
    )

    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["read_only"] is True
    assert payload["error_type"] == "WorkspaceNotFoundError"


def test_mutation_not_allowed_response_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(
        AdapterRequest(action="init_workspace", allow_mutation=False)
    )

    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["error_type"] == "MutationNotAllowed"
    assert payload["read_only"] is False
    assert not (tmp_path / ".weaveflow").exists()


def test_init_workspace_success_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(
        AdapterRequest(action="init_workspace", allow_mutation=True)
    )

    payload = validate_response(response)

    assert payload["ok"] is True
    assert payload["read_only"] is False
    assert (tmp_path / ".weaveflow").is_dir()


def test_create_task_success_validates(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))

    response = adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Adapter response task"},
            allow_mutation=True,
        )
    )
    payload = validate_response(response)

    assert payload["ok"] is True
    assert payload["read_only"] is False
    assert payload["data"]["id"] == "TASK-0001"
    assert (
        tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_create_plan_and_worker_brief_responses_validate(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Plan and brief contract"},
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
            params={"task_id": "TASK-0001"},
            allow_mutation=True,
        )
    )

    assert validate_response(plan_response)["read_only"] is False
    assert validate_response(brief_response)["read_only"] is False
    task_dir = tmp_path / ".weaveflow" / "tasks" / "TASK-0001"
    assert (task_dir / "plan.yaml").is_file()
    assert (task_dir / "worker_brief_codex.md").is_file()


def test_show_task_read_only_response_validates(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Show task contract"},
            allow_mutation=True,
        )
    )

    response = adapter.handle(
        AdapterRequest(action="show_task", params={"task_id": "TASK-0001"})
    )
    payload = validate_response(response)

    assert payload["ok"] is True
    assert payload["read_only"] is True
    assert payload["data"]["id"] == "TASK-0001"


def test_attach_result_missing_file_response_validates(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Missing result contract"},
            allow_mutation=True,
        )
    )
    task_spec_path = tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"

    response = adapter.handle(
        AdapterRequest(
            action="attach_result",
            params={"task_id": "TASK-0001", "result_path": "missing.md"},
            allow_mutation=True,
        )
    )
    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["error_type"] == "MissingResultFileError"
    assert payload["read_only"] is False
    assert read_yaml(task_spec_path)["status"] == "draft"


def test_verify_invalid_status_response_validates(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))
    adapter.handle(
        AdapterRequest(
            action="create_task",
            params={"user_request": "Invalid verify contract"},
            allow_mutation=True,
        )
    )

    response = adapter.handle(
        AdapterRequest(
            action="verify_task",
            params={"task_id": "TASK-0001", "status": "invalid", "note": "bad"},
            allow_mutation=True,
        )
    )
    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["error_type"] == "InvalidVerificationStatusError"
    assert payload["read_only"] is False


def test_unsupported_action_response_validates(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(
        AdapterRequest(action="does_not_exist")
    )
    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["error_type"] == "UnsupportedAction"
    assert payload["error_message"]


def test_missing_required_param_response_validates(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True))

    response = adapter.handle(
        AdapterRequest(action="create_task", allow_mutation=True)
    )
    payload = validate_response(response)

    assert payload["ok"] is False
    assert payload["error_type"] == "InvalidAdapterRequest"
    assert "user_request" in payload["error_message"]


def test_request_id_round_trip(tmp_path: Path) -> None:
    response = WeaveflowServiceAdapter(tmp_path).handle(
        AdapterRequest(action="status", request_id="req-123")
    )
    payload = validate_response(response)

    assert payload["request_id"] == "req-123"


def test_full_adapter_workflow_responses_validate(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    responses = [
        adapter.handle(AdapterRequest(action="init_workspace", allow_mutation=True)),
        adapter.handle(
            AdapterRequest(
                action="create_task",
                params={"user_request": "Full contract workflow"},
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

    payloads = [validate_response(response) for response in responses]

    assert all(payload["ok"] for payload in payloads)
    assert payloads[-2]["data"]["tasks"][0]["status"] == "completed"
    assert payloads[-1]["data"]["healthy"] is True


def test_schema_rejects_missing_contract_version() -> None:
    payload = valid_payload()
    payload.pop("contract_version")

    with pytest.raises(ValidationError):
        Draft202012Validator(load_schema()).validate(payload)


def test_schema_rejects_wrong_contract_version() -> None:
    payload = {**valid_payload(), "contract_version": "weaveflow.v2"}

    with pytest.raises(ValidationError):
        Draft202012Validator(load_schema()).validate(payload)


def test_schema_rejects_missing_required_fields() -> None:
    schema = load_schema()
    for field in REQUIRED_FIELDS:
        payload = valid_payload()
        payload.pop(field)
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate(payload)
