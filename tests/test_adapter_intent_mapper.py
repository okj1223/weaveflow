import subprocess
from pathlib import Path

from projectops.adapters import IntentMappingResult, ProjectOpsServiceAdapter
from projectops.adapters.intent_mapper import map_text_to_adapter_request


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_intent_mapping_demo.py"
DOC_PATH = ROOT / "docs" / "adapter_intent_mapping.md"


def test_intent_mapper_imports() -> None:
    result = map_text_to_adapter_request("status")

    assert isinstance(result, IntentMappingResult)


def test_empty_input_returns_empty_intent() -> None:
    result = map_text_to_adapter_request("   ")

    assert result.ok is False
    assert result.error_type == "EmptyIntent"
    assert result.request is None


def test_unknown_input_returns_unknown_intent() -> None:
    result = map_text_to_adapter_request("please do magic")

    assert result.ok is False
    assert result.error_type == "UnknownIntent"
    assert result.request is None


def test_status_mapping() -> None:
    result = map_text_to_adapter_request("status")

    assert result.ok is True
    assert result.action == "status"
    assert result.is_mutating is False
    assert result.requires_confirmation is False
    assert result.request is not None
    assert result.request.allow_mutation is False


def test_list_tasks_mapping() -> None:
    result = map_text_to_adapter_request("list tasks")

    assert result.ok is True
    assert result.action == "list_tasks"


def test_doctor_mapping() -> None:
    result = map_text_to_adapter_request("workspace health")

    assert result.ok is True
    assert result.action == "doctor"


def test_show_task_mapping_normalizes_task_id() -> None:
    result = map_text_to_adapter_request("show task task-0001")

    assert result.ok is True
    assert result.action == "show_task"
    assert result.params["task_id"] == "TASK-0001"


def test_init_mapping_mutation_confirmation() -> None:
    result = map_text_to_adapter_request("init workspace")

    assert result.ok is True
    assert result.action == "init_workspace"
    assert result.is_mutating is True
    assert result.requires_confirmation is True
    assert result.request is not None
    assert result.request.allow_mutation is False

    confirmed = map_text_to_adapter_request("init workspace", allow_mutation=True)

    assert confirmed.requires_confirmation is False
    assert confirmed.request is not None
    assert confirmed.request.allow_mutation is True


def test_create_task_mapping() -> None:
    result = map_text_to_adapter_request("create task Investigate auth bug")

    assert result.ok is True
    assert result.action == "create_task"
    assert result.params["user_request"] == "Investigate auth bug"
    assert result.is_mutating is True
    assert result.requires_confirmation is True


def test_create_task_missing_request_returns_invalid_intent() -> None:
    result = map_text_to_adapter_request("create task")

    assert result.ok is False
    assert result.error_type == "InvalidIntent"
    assert "user_request" in (result.error_message or "")


def test_plan_mapping() -> None:
    result = map_text_to_adapter_request("plan TASK-0001")

    assert result.ok is True
    assert result.action == "create_plan"
    assert result.params["task_id"] == "TASK-0001"


def test_brief_mapping() -> None:
    result = map_text_to_adapter_request("brief TASK-0001")
    explicit = map_text_to_adapter_request("brief TASK-0001 codex")

    assert result.ok is True
    assert result.action == "create_worker_brief"
    assert result.params == {"task_id": "TASK-0001", "worker": "codex"}
    assert explicit.params == {"task_id": "TASK-0001", "worker": "codex"}


def test_attach_mapping() -> None:
    result = map_text_to_adapter_request("attach TASK-0001 examples/result.md")

    assert result.ok is True
    assert result.action == "attach_result"
    assert result.params == {
        "task_id": "TASK-0001",
        "result_path": "examples/result.md",
    }

    missing = map_text_to_adapter_request("attach TASK-0001")
    assert missing.ok is False
    assert missing.error_type == "InvalidIntent"


def test_verify_mapping() -> None:
    result = map_text_to_adapter_request("verify TASK-0001 passed manual check")

    assert result.ok is True
    assert result.action == "verify_task"
    assert result.params == {
        "task_id": "TASK-0001",
        "status": "passed",
        "note": "manual check",
    }

    invalid = map_text_to_adapter_request("verify TASK-0001 invalid note")
    assert invalid.ok is False
    assert invalid.error_type == "InvalidIntent"


def test_report_mapping() -> None:
    result = map_text_to_adapter_request("report TASK-0001")

    assert result.ok is True
    assert result.action == "create_final_report"
    assert result.params["task_id"] == "TASK-0001"


def test_memory_mapping() -> None:
    result = map_text_to_adapter_request("memory propose TASK-0001")

    assert result.ok is True
    assert result.action == "propose_memory_update"
    assert result.params["task_id"] == "TASK-0001"


def test_request_id_preserved() -> None:
    result = map_text_to_adapter_request("status", request_id="req-123")

    assert result.request is not None
    assert result.request.request_id == "req-123"


def test_mapper_does_not_touch_files(tmp_path: Path) -> None:
    result = map_text_to_adapter_request("init workspace", allow_mutation=True)

    assert result.ok is True
    assert not (tmp_path / ".projectops").exists()


def test_mapper_integrates_with_service_adapter(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    commands = [
        ("init workspace", True),
        ("create task Mapper integration", True),
        ("plan TASK-0001", True),
        ("brief TASK-0001", True),
        ("doctor", False),
    ]

    responses = []
    for text, allow_mutation in commands:
        result = map_text_to_adapter_request(text, allow_mutation=allow_mutation)
        assert result.request is not None
        responses.append(adapter.handle(result.request))

    assert all(response.ok for response in responses)
    assert responses[-1].data is not None
    assert responses[-1].data["healthy"] is True


def test_requires_confirmation_blocks_if_directly_handled(tmp_path: Path) -> None:
    adapter = ProjectOpsServiceAdapter(tmp_path)
    init_result = map_text_to_adapter_request("init workspace", allow_mutation=True)
    assert init_result.request is not None
    assert adapter.handle(init_result.request).ok is True

    result = map_text_to_adapter_request("create task Should not run")
    assert result.requires_confirmation is True
    assert result.request is not None
    response = adapter.handle(result.request)

    assert response.ok is False
    assert response.error_type == "MutationNotAllowed"
    assert not (tmp_path / ".projectops" / "tasks" / "TASK-0001").exists()


def test_intent_mapping_demo_script_runs() -> None:
    assert DEMO_PATH.exists()

    result = subprocess.run(
        ["python3", str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "status" in result.stdout
    assert "init workspace" in result.stdout
    assert "create task" in result.stdout
    assert "requires_confirmation" in result.stdout
    assert "list tasks" in result.stdout
    assert "doctor" in result.stdout
    assert "UnknownIntent" in result.stdout


def test_intent_mapping_docs_and_links() -> None:
    assert DOC_PATH.exists()
    doc_text = DOC_PATH.read_text(encoding="utf-8")
    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
    interface_text = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )
    usage_text = (ROOT / "docs" / "adapter_usage_examples.md").read_text(
        encoding="utf-8"
    )

    assert "docs/adapter_intent_mapping.md" in readme_text
    assert "adapter_intent_mapping" in interface_text
    assert "adapter_intent_mapping" in usage_text
    for expected in ["OpenClaw", "allow_mutation", "UnknownIntent"]:
        assert expected in doc_text
