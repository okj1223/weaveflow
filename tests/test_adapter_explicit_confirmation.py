import json
import subprocess
import sys
from pathlib import Path

import pytest

from projectops.adapters.explicit_confirmation import (
    ExplicitConfirmationCheck,
    ExplicitConfirmationPrompt,
    build_explicit_confirmation_phrase,
    check_explicit_confirmation,
    create_explicit_confirmation_prompt,
)
from projectops.adapters.local_wrapper import LocalBridgeWrapper
from projectops.adapters.permission_preflight import (
    preflight_openclaw_payload,
    preflight_text_command,
)
from projectops.json_io import to_jsonable


ROOT = Path(__file__).resolve().parents[1]
DEMO_PATH = ROOT / "examples" / "adapter_explicit_confirmation_demo.py"
DOC_PATH = ROOT / "docs" / "adapter_explicit_confirmation.md"


def payload(
    text: str = "verify TASK-0001 passed manual check",
    message_id: str = "m-verify",
) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def sensitive_preflight(request_id: str | None = None):
    return preflight_text_command(
        "verify TASK-0001 passed manual check",
        allow_mutation=True,
        explicit_confirmation=False,
        request_id=request_id,
        bridge_request_id="bridge-verify",
    )


def test_explicit_confirmation_imports() -> None:
    assert ExplicitConfirmationPrompt
    assert ExplicitConfirmationCheck
    assert build_explicit_confirmation_phrase
    assert create_explicit_confirmation_prompt
    assert check_explicit_confirmation


def test_build_phrase_without_request_id() -> None:
    assert build_explicit_confirmation_phrase("verify_task") == "confirm verify_task"


def test_build_phrase_with_request_id() -> None:
    assert (
        build_explicit_confirmation_phrase("verify_task", "req-123")
        == "confirm verify_task req-123"
    )


def test_build_phrase_lowercases_action() -> None:
    assert (
        build_explicit_confirmation_phrase("Verify_Task", "req-123")
        == "confirm verify_task req-123"
    )


def test_create_prompt_for_sensitive_preflight() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight())

    assert prompt.action == "verify_task"
    assert "verify_task" in prompt.confirmation_phrase
    assert prompt.confirmation_phrase in prompt.instruction
    assert prompt.warning


def test_create_prompt_rejects_non_sensitive_preflight() -> None:
    preflight = preflight_text_command("status")

    with pytest.raises(ValueError):
        create_explicit_confirmation_prompt(preflight)


def test_correct_confirmation_matches() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation(prompt.confirmation_phrase, prompt)

    assert result.ok is True
    assert result.matched is True


def test_confirmation_matching_is_case_insensitive_and_trims() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation(
        f"  {prompt.confirmation_phrase.upper()}  ",
        prompt,
    )

    assert result.ok is True
    assert result.matched is True


def test_wrong_confirmation_fails() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation("yes", prompt)

    assert result.ok is False
    assert result.matched is False
    assert result.error_type == "ExplicitConfirmationMismatch"


def test_empty_confirmation_fails() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation("", prompt)

    assert result.ok is False
    assert result.matched is False
    assert result.error_type == "EmptyExplicitConfirmation"


def test_request_id_preserved() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation(prompt.confirmation_phrase, prompt)

    assert prompt.request_id == "req-123"
    assert result.request_id == "req-123"


def test_prompt_and_check_json_serializable() -> None:
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    result = check_explicit_confirmation(prompt.confirmation_phrase, prompt)

    json.dumps(to_jsonable(prompt))
    json.dumps(to_jsonable(result))


def test_helper_does_not_touch_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    prompt = create_explicit_confirmation_prompt(sensitive_preflight("req-123"))
    check_explicit_confirmation(prompt.confirmation_phrase, prompt)

    assert not tmp_path.joinpath(".projectops").exists()


def test_payload_permission_preflight_integration() -> None:
    preflight = preflight_openclaw_payload(
        payload(message_id="m-verify"),
        allow_mutation=True,
        explicit_confirmation=False,
        bridge_request_id="bridge-verify",
    )
    prompt = create_explicit_confirmation_prompt(preflight)
    result = check_explicit_confirmation(prompt.confirmation_phrase, prompt)

    assert prompt.request_id == "m-verify"
    assert result.matched is True


def test_local_wrapper_prepare_explicit_confirmation_without_starting_bridge(
    tmp_path: Path,
) -> None:
    wrapper = LocalBridgeWrapper(tmp_path)
    prompt = wrapper.prepare_explicit_confirmation(
        payload(message_id="m-verify"),
        bridge_request_id="bridge-verify",
    )

    assert wrapper.is_running() is False
    assert prompt.action == "verify_task"
    assert prompt.request_id == "m-verify"


def test_explicit_confirmation_demo_runs() -> None:
    assert DEMO_PATH.exists()
    result = subprocess.run(
        [sys.executable, str(DEMO_PATH)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    for term in [
        "verify_task",
        "confirmation_phrase",
        "yes",
        "mismatch",
        "matched",
    ]:
        assert term in result.stdout


def test_explicit_confirmation_docs() -> None:
    assert DOC_PATH.exists()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    preflight = (ROOT / "docs" / "adapter_permission_preflight.md").read_text(
        encoding="utf-8"
    )
    wrapper = (ROOT / "docs" / "local_wrapper_flow.md").read_text(encoding="utf-8")
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    doc = DOC_PATH.read_text(encoding="utf-8")

    assert "docs/adapter_explicit_confirmation.md" in readme
    assert "explicit confirmation" in preflight.lower()
    assert "explicit confirmation" in wrapper.lower()
    assert "explicit confirmation" in design.lower()
    for term in [
        "attach_result",
        "verify_task",
        "create_final_report",
        "confirm verify_task",
        "not authentication",
        "OpenClaw",
    ]:
        assert term in doc


def test_runtime_compatibility_local_wrapper_status(tmp_path: Path) -> None:
    wrapper = LocalBridgeWrapper(tmp_path)
    try:
        health = wrapper.start()
        assert health.ok is True
        result = wrapper.handle_payload(payload("status", "m-status"))
        assert result.routed is True
        assert result.ok is True
    finally:
        wrapper.shutdown()
