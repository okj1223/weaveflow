import subprocess
from pathlib import Path

from weaveflow.adapters import WeaveflowServiceAdapter
from weaveflow.adapters.confirmation import (
    ConfirmationState,
    confirm_request,
    is_confirmation_response,
    prepare_confirmation,
    reject_request,
)


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_confirmation_demo.py"


def test_confirmation_imports() -> None:
    state = prepare_confirmation("status")

    assert isinstance(state, ConfirmationState)
    assert callable(confirm_request)
    assert callable(reject_request)
    assert callable(is_confirmation_response)


def test_read_only_command_does_not_require_confirmation() -> None:
    state = prepare_confirmation("status")

    assert state.required is False
    assert state.confirmed is True
    assert state.action == "status"
    assert state.request is not None
    assert state.request.action == "status"
    assert state.request.allow_mutation is False


def test_mutating_command_requires_confirmation() -> None:
    state = prepare_confirmation("init workspace")

    assert state.required is True
    assert state.confirmed is False
    assert state.action == "init_workspace"
    assert state.request is not None
    assert state.request.action == "init_workspace"
    assert state.request.allow_mutation is False


def test_confirm_request_flips_allow_mutation_true() -> None:
    state = prepare_confirmation("create task Confirm me", request_id="req-1")
    confirmed = confirm_request(state)

    assert confirmed.required is False
    assert confirmed.confirmed is True
    assert confirmed.action == state.action
    assert confirmed.params == state.params
    assert confirmed.request_id == "req-1"
    assert confirmed.request is not None
    assert confirmed.request.allow_mutation is True
    assert confirmed.request.action == "create_task"
    assert confirmed.request.params == {"user_request": "Confirm me"}


def test_reject_request_clears_executable_request() -> None:
    state = prepare_confirmation("create task Reject me")
    rejected = reject_request(state)

    assert rejected.required is False
    assert rejected.confirmed is False
    assert rejected.request is None
    assert rejected.action == "create_task"
    assert rejected.params == state.params


def test_mapping_failure_creates_non_executable_state() -> None:
    state = prepare_confirmation("unknown nonsense")

    assert state.required is False
    assert state.confirmed is False
    assert state.request is None
    assert "UnknownIntent" in state.message


def test_empty_input_creates_non_executable_state() -> None:
    state = prepare_confirmation("   ")

    assert state.required is False
    assert state.confirmed is False
    assert state.request is None
    assert "EmptyIntent" in state.message or "Empty command" in state.message


def test_request_id_preserved_after_confirmation() -> None:
    state = prepare_confirmation("create task Test request", request_id="req-123")
    confirmed = confirm_request(state)

    assert confirmed.request_id == "req-123"
    assert confirmed.request is not None
    assert confirmed.request.request_id == "req-123"


def test_rejection_prevents_mutation(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    state = prepare_confirmation("init workspace")
    rejected = reject_request(state)

    assert rejected.request is None
    assert not (tmp_path / ".weaveflow").exists()
    assert adapter


def test_confirmed_request_executes_through_adapter(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    state = prepare_confirmation("init workspace")
    confirmed = confirm_request(state)

    assert confirmed.request is not None
    response = adapter.handle(confirmed.request)

    assert response.ok is True
    assert (tmp_path / ".weaveflow").is_dir()


def test_confirmed_create_task_executes_through_adapter(tmp_path: Path) -> None:
    adapter = WeaveflowServiceAdapter(tmp_path)
    init_state = confirm_request(prepare_confirmation("init workspace"))
    assert init_state.request is not None
    assert adapter.handle(init_state.request).ok is True

    create_state = confirm_request(prepare_confirmation("create task Confirmed task"))
    assert create_state.request is not None
    response = adapter.handle(create_state.request)

    assert response.ok is True
    assert response.data is not None
    assert response.data["id"] == "TASK-0001"
    assert (
        tmp_path / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()


def test_is_confirmation_response() -> None:
    for text in ["yes", "y", "confirm", "approved", "ok"]:
        assert is_confirmation_response(text) is True
    for text in ["no", "n", "cancel", "reject", "stop"]:
        assert is_confirmation_response(text) is False
    assert is_confirmation_response("maybe") is None


def test_confirmation_helper_does_not_touch_files(tmp_path: Path) -> None:
    state = prepare_confirmation("init workspace")

    assert state.required is True
    assert not (tmp_path / ".weaveflow").exists()


def test_confirmation_demo_script_runs() -> None:
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
    assert "required=True" in result.stdout
    assert "rejected" in result.stdout
    assert "confirmed" in result.stdout
    assert "create task" in result.stdout
    assert "doctor" in result.stdout


def test_confirmation_docs_and_links() -> None:
    intent_doc = (ROOT / "docs" / "adapter_intent_mapping.md").read_text(
        encoding="utf-8"
    )
    interface_doc = (ROOT / "docs" / "external_adapter_interface.md").read_text(
        encoding="utf-8"
    )
    usage_doc = (ROOT / "docs" / "adapter_usage_examples.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Confirmation flow" in intent_doc
    assert "confirmation" in interface_doc.lower()
    assert "confirmation" in usage_doc.lower()
    assert "confirmation" in readme.lower()
