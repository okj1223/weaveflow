import json
import subprocess
import sys
from pathlib import Path

from projectops.adapters import (
    AdapterActionPolicy,
    PermissionDecision,
    evaluate_action_permission,
    get_action_policy,
)
from projectops.adapters.openclaw import OpenClawAdapter, OpenClawMessage
from projectops.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]

READ_ONLY_ACTIONS = ["status", "list_tasks", "doctor", "show_task"]
SAFE_MUTATION_ACTIONS = [
    "init_workspace",
    "create_task",
    "create_plan",
    "create_worker_brief",
    "propose_memory_update",
]
SENSITIVE_MUTATION_ACTIONS = [
    "attach_result",
    "verify_task",
    "create_final_report",
]
FUTURE_HIGH_RISK_ACTIONS = [
    "auto_run_codex",
    "apply_memory_diff",
    "repair_workspace",
    "delete_artifact",
    "edit_task_history",
    "deploy",
    "external_api_action",
]


def msg(text: str, message_id: str) -> OpenClawMessage:
    return OpenClawMessage(
        channel_id="channel-1",
        user_id="user-1",
        message_id=message_id,
        text=text,
        timestamp="2026-05-09T00:00:00Z",
        thread_id="thread-1",
    )


def test_adapter_permission_imports() -> None:
    assert AdapterActionPolicy
    assert PermissionDecision
    assert get_action_policy
    assert evaluate_action_permission


def test_read_only_classification() -> None:
    for action in READ_ONLY_ACTIONS:
        policy = get_action_policy(action)
        assert policy.category == "read_only"
        assert policy.read_only is True
        assert policy.mutating is False
        assert policy.requires_confirmation is False
        assert policy.supported is True


def test_safe_mutation_classification() -> None:
    for action in SAFE_MUTATION_ACTIONS:
        policy = get_action_policy(action)
        assert policy.category == "safe_mutation"
        assert policy.mutating is True
        assert policy.requires_confirmation is True
        assert policy.requires_explicit_confirmation is False
        assert policy.supported is True


def test_sensitive_mutation_classification() -> None:
    for action in SENSITIVE_MUTATION_ACTIONS:
        policy = get_action_policy(action)
        assert policy.category == "sensitive_mutation"
        assert policy.mutating is True
        assert policy.sensitive is True
        assert policy.requires_confirmation is True
        assert policy.requires_explicit_confirmation is True
        assert policy.supported is True


def test_future_high_risk_classification() -> None:
    for action in FUTURE_HIGH_RISK_ACTIONS:
        policy = get_action_policy(action)
        decision = evaluate_action_permission(action, allow_mutation=True, explicit_confirmation=True)
        assert policy.category == "future_high_risk"
        assert policy.future_high_risk is True
        assert policy.supported is False
        assert decision.blocked is True


def test_unknown_classification() -> None:
    policy = get_action_policy("does_not_exist")
    decision = evaluate_action_permission("does_not_exist")

    assert policy.category == "unknown"
    assert policy.supported is False
    assert decision.blocked is True


def test_read_only_permission() -> None:
    decision = evaluate_action_permission("status")

    assert decision.allowed is True
    assert decision.blocked is False


def test_safe_mutation_without_allow_mutation() -> None:
    decision = evaluate_action_permission("create_task")

    assert decision.allowed is False
    assert decision.blocked is False
    assert decision.requires_confirmation is True


def test_safe_mutation_with_allow_mutation() -> None:
    decision = evaluate_action_permission("create_task", allow_mutation=True)

    assert decision.allowed is True
    assert decision.blocked is False


def test_sensitive_mutation_without_allow_mutation() -> None:
    decision = evaluate_action_permission("verify_task")

    assert decision.allowed is False
    assert decision.requires_confirmation is True
    assert decision.requires_explicit_confirmation is True


def test_sensitive_mutation_with_allow_mutation_but_no_explicit_confirmation() -> None:
    decision = evaluate_action_permission("verify_task", allow_mutation=True)

    assert decision.allowed is False
    assert decision.blocked is False
    assert decision.requires_explicit_confirmation is True


def test_sensitive_mutation_with_explicit_confirmation() -> None:
    decision = evaluate_action_permission(
        "verify_task",
        allow_mutation=True,
        explicit_confirmation=True,
    )

    assert decision.allowed is True
    assert decision.blocked is False


def test_future_high_risk_is_blocked() -> None:
    decision = evaluate_action_permission(
        "auto_run_codex",
        allow_mutation=True,
        explicit_confirmation=True,
    )

    assert decision.allowed is False
    assert decision.blocked is True


def test_unknown_is_blocked() -> None:
    decision = evaluate_action_permission("unknown_action")

    assert decision.allowed is False
    assert decision.blocked is True


def test_permission_models_are_json_serializable() -> None:
    policy = get_action_policy("create_task")
    decision = evaluate_action_permission("create_task")

    json.dumps(to_jsonable(policy))
    json.dumps(to_jsonable(decision))


def test_adapter_permission_demo_runs() -> None:
    script = ROOT / "examples" / "adapter_permission_demo.py"

    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=ROOT,
        check=False,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0
    assert "status" in result.stdout
    assert "create_task" in result.stdout
    assert "verify_task" in result.stdout
    assert "auto_run_codex" in result.stdout
    assert "unknown_action" in result.stdout
    assert "future_high_risk" in result.stdout


def test_adapter_permission_docs() -> None:
    permission_doc = (ROOT / "docs" / "adapter_permission_policy.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    openclaw = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    pipeline = (ROOT / "docs" / "adapter_pipeline_contract.md").read_text(
        encoding="utf-8"
    )

    assert "docs/adapter_permission_policy.md" in readme
    assert "adapter_permission_policy.md" in openclaw
    assert "permission policy" in pipeline
    for term in [
        "read_only",
        "safe_mutation",
        "sensitive_mutation",
        "future_high_risk",
        "OpenClaw",
        "allow_mutation",
        "explicit_confirmation",
    ]:
        assert term in permission_doc


def test_current_openclaw_runtime_behavior_remains_unchanged(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    init_pending = adapter.handle_message(msg("init workspace", "m-init"))
    init_confirmed = adapter.handle_message(msg("yes", "m-init-yes"))
    task_pending = adapter.handle_message(
        msg("create task Permission policy runtime compatibility", "m-task")
    )
    task_confirmed = adapter.handle_message(msg("yes", "m-task-yes"))

    assert init_pending.event_type == "pending_confirmation"
    assert init_confirmed.ok is True
    assert task_pending.event_type == "pending_confirmation"
    assert task_confirmed.ok is True
    assert (
        tmp_path / ".projectops" / "tasks" / "TASK-0001" / "task_spec.yaml"
    ).is_file()
