"""Deterministic text-to-adapter request mapping."""

from __future__ import annotations

import re
from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.base import AdapterRequest
from projectops.adapters.service_adapter import MUTATING_ACTIONS, READ_ONLY_ACTIONS


TASK_ID_PATTERN = r"TASK-[0-9]{4}"
DEFAULT_VERIFY_NOTE = "verified through external adapter command"
VERIFY_STATUSES = {"passed", "failed", "blocked"}


class IntentMappingResult(BaseModel):
    ok: bool
    original_text: str
    normalized_text: str
    action: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    is_mutating: bool = False
    requires_confirmation: bool = False
    request: Optional[AdapterRequest] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None


def map_text_to_adapter_request(
    text: str,
    allow_mutation: bool = False,
    request_id: Optional[str] = None,
) -> IntentMappingResult:
    original_text = text
    stripped = text.strip()
    normalized = normalize_text(stripped)

    if not stripped:
        return mapping_error(original_text, normalized, "EmptyIntent", "Empty command.")

    if normalized in {"status", "/status", "workspace status", "show status"}:
        return mapping_success(
            original_text, normalized, "status", {}, allow_mutation, request_id
        )

    if normalized in {"tasks", "/tasks", "list tasks", "task list", "show tasks"}:
        return mapping_success(
            original_text, normalized, "list_tasks", {}, allow_mutation, request_id
        )

    if normalized in {"doctor", "/doctor", "check health", "workspace health", "health"}:
        return mapping_success(
            original_text, normalized, "doctor", {}, allow_mutation, request_id
        )

    show_match = match_pattern(stripped, rf"(?:show\s+task|show|task)\s+({TASK_ID_PATTERN})")
    if show_match:
        return mapping_success(
            original_text,
            normalized,
            "show_task",
            {"task_id": task_id(show_match.group(1))},
            allow_mutation,
            request_id,
        )

    if normalized in {"init", "/init", "init workspace", "initialize workspace"}:
        return mapping_success(
            original_text,
            normalized,
            "init_workspace",
            {},
            allow_mutation,
            request_id,
        )

    create_match = match_pattern(
        stripped,
        r"(?:create\s+task|new\s+task|task\s+create)(?:\s+(.+))?",
    )
    if create_match:
        user_request = (create_match.group(1) or "").strip()
        if not user_request:
            return mapping_error(
                original_text,
                normalized,
                "InvalidIntent",
                "Missing user_request for create_task command.",
            )
        return mapping_success(
            original_text,
            normalized,
            "create_task",
            {"user_request": user_request},
            allow_mutation,
            request_id,
        )

    plan_match = match_pattern(
        stripped,
        rf"(?:plan\s+task|create\s+plan|plan)\s+({TASK_ID_PATTERN})",
    )
    if plan_match:
        return mapping_success(
            original_text,
            normalized,
            "create_plan",
            {"task_id": task_id(plan_match.group(1))},
            allow_mutation,
            request_id,
        )

    brief_match = match_pattern(
        stripped,
        rf"brief\s+({TASK_ID_PATTERN})(?:\s+(\S+))?",
    )
    if not brief_match:
        brief_match = match_pattern(
            stripped,
            rf"(?:create\s+brief|worker\s+brief)\s+({TASK_ID_PATTERN})",
        )
    if brief_match:
        worker = brief_match.group(2) if brief_match.lastindex and brief_match.lastindex >= 2 else None
        return mapping_success(
            original_text,
            normalized,
            "create_worker_brief",
            {"task_id": task_id(brief_match.group(1)), "worker": worker or "codex"},
            allow_mutation,
            request_id,
        )

    codex_brief_match = match_pattern(
        stripped,
        rf"create\s+codex\s+brief\s+({TASK_ID_PATTERN})",
    )
    if codex_brief_match:
        return mapping_success(
            original_text,
            normalized,
            "create_worker_brief",
            {"task_id": task_id(codex_brief_match.group(1)), "worker": "codex"},
            allow_mutation,
            request_id,
        )

    attach_match = match_pattern(
        stripped,
        rf"attach\s+result\s+({TASK_ID_PATTERN})(?:\s+(.+))?",
    )
    if not attach_match:
        attach_match = match_pattern(
            stripped,
            rf"attach\s+({TASK_ID_PATTERN})(?:\s+(.+))?",
        )
    if attach_match:
        result_path = (attach_match.group(2) or "").strip()
        if not result_path:
            return mapping_error(
                original_text,
                normalized,
                "InvalidIntent",
                "Missing result_path for attach_result command.",
            )
        return mapping_success(
            original_text,
            normalized,
            "attach_result",
            {"task_id": task_id(attach_match.group(1)), "result_path": result_path},
            allow_mutation,
            request_id,
        )

    verify_match = match_pattern(
        stripped,
        rf"verify(?:\s+task)?\s+({TASK_ID_PATTERN})(?:\s+(\S+))?(?:\s+(.+))?",
    )
    if verify_match:
        status = (verify_match.group(2) or "").lower()
        if status not in VERIFY_STATUSES:
            return mapping_error(
                original_text,
                normalized,
                "InvalidIntent",
                "Invalid verification status. Expected one of: passed, failed, blocked.",
            )
        note = (verify_match.group(3) or "").strip() or DEFAULT_VERIFY_NOTE
        return mapping_success(
            original_text,
            normalized,
            "verify_task",
            {
                "task_id": task_id(verify_match.group(1)),
                "status": status,
                "note": note,
            },
            allow_mutation,
            request_id,
        )

    report_match = match_pattern(
        stripped,
        rf"(?:final\s+report|create\s+report|report)\s+({TASK_ID_PATTERN})",
    )
    if report_match:
        return mapping_success(
            original_text,
            normalized,
            "create_final_report",
            {"task_id": task_id(report_match.group(1))},
            allow_mutation,
            request_id,
        )

    memory_match = match_pattern(
        stripped,
        rf"(?:memory\s+propose|propose\s+memory|memory)\s+({TASK_ID_PATTERN})",
    )
    if memory_match:
        return mapping_success(
            original_text,
            normalized,
            "propose_memory_update",
            {"task_id": task_id(memory_match.group(1))},
            allow_mutation,
            request_id,
        )

    return mapping_error(
        original_text,
        normalized,
        "UnknownIntent",
        f"Could not map command: {stripped}",
    )


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip()).lower()


def match_pattern(text: str, pattern: str) -> Optional[re.Match[str]]:
    return re.fullmatch(pattern, text.strip(), flags=re.IGNORECASE)


def task_id(value: str) -> str:
    return value.upper()


def mapping_success(
    original_text: str,
    normalized_text: str,
    action: str,
    params: dict[str, Any],
    allow_mutation: bool,
    request_id: Optional[str],
) -> IntentMappingResult:
    is_mutating = action in MUTATING_ACTIONS
    if action not in READ_ONLY_ACTIONS and not is_mutating:
        return mapping_error(
            original_text,
            normalized_text,
            "UnknownIntent",
            f"Unsupported adapter action: {action}",
        )
    request_allow_mutation = allow_mutation if is_mutating else False
    requires_confirmation = is_mutating and not allow_mutation
    request = AdapterRequest(
        action=action,
        params=params,
        allow_mutation=request_allow_mutation,
        request_id=request_id,
    )
    return IntentMappingResult(
        ok=True,
        original_text=original_text,
        normalized_text=normalized_text,
        action=action,
        params=params,
        is_mutating=is_mutating,
        requires_confirmation=requires_confirmation,
        request=request,
        error_type=None,
        error_message=None,
    )


def mapping_error(
    original_text: str,
    normalized_text: str,
    error_type: str,
    error_message: str,
) -> IntentMappingResult:
    return IntentMappingResult(
        ok=False,
        original_text=original_text,
        normalized_text=normalized_text,
        action=None,
        params={},
        is_mutating=False,
        requires_confirmation=False,
        request=None,
        error_type=error_type,
        error_message=error_message,
    )
