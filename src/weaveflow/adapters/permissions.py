"""Advisory adapter action permission policy."""

from __future__ import annotations

from pydantic import BaseModel


READ_ONLY = "read_only"
SAFE_MUTATION = "safe_mutation"
SENSITIVE_MUTATION = "sensitive_mutation"
FUTURE_HIGH_RISK = "future_high_risk"
UNKNOWN = "unknown"

READ_ONLY_ACTIONS = {"status", "list_tasks", "doctor", "show_task"}
SAFE_MUTATION_ACTIONS = {
    "init_workspace",
    "create_task",
    "create_plan",
    "create_worker_brief",
    "propose_memory_update",
}
SENSITIVE_MUTATION_ACTIONS = {
    "attach_result",
    "verify_task",
    "create_final_report",
}
FUTURE_HIGH_RISK_ACTIONS = {
    "auto_run_codex",
    "apply_memory_diff",
    "repair_workspace",
    "delete_artifact",
    "edit_task_history",
    "deploy",
    "external_api_action",
}


class AdapterActionPolicy(BaseModel):
    action: str
    category: str
    read_only: bool
    mutating: bool
    sensitive: bool
    future_high_risk: bool
    requires_confirmation: bool
    requires_explicit_confirmation: bool
    supported: bool
    reason: str


class PermissionDecision(BaseModel):
    action: str
    allowed: bool
    category: str
    read_only: bool
    mutating: bool
    requires_confirmation: bool
    requires_explicit_confirmation: bool
    blocked: bool
    reason: str
    policy: AdapterActionPolicy


def get_action_policy(action: str) -> AdapterActionPolicy:
    if action in READ_ONLY_ACTIONS:
        return AdapterActionPolicy(
            action=action,
            category=READ_ONLY,
            read_only=True,
            mutating=False,
            sensitive=False,
            future_high_risk=False,
            requires_confirmation=False,
            requires_explicit_confirmation=False,
            supported=True,
            reason="Read-only action.",
        )
    if action in SAFE_MUTATION_ACTIONS:
        return AdapterActionPolicy(
            action=action,
            category=SAFE_MUTATION,
            read_only=False,
            mutating=True,
            sensitive=False,
            future_high_risk=False,
            requires_confirmation=True,
            requires_explicit_confirmation=False,
            supported=True,
            reason="Mutating action that requires confirmation.",
        )
    if action in SENSITIVE_MUTATION_ACTIONS:
        return AdapterActionPolicy(
            action=action,
            category=SENSITIVE_MUTATION,
            read_only=False,
            mutating=True,
            sensitive=True,
            future_high_risk=False,
            requires_confirmation=True,
            requires_explicit_confirmation=True,
            supported=True,
            reason="Sensitive mutating action that requires explicit confirmation.",
        )
    if action in FUTURE_HIGH_RISK_ACTIONS:
        return AdapterActionPolicy(
            action=action,
            category=FUTURE_HIGH_RISK,
            read_only=False,
            mutating=True,
            sensitive=True,
            future_high_risk=True,
            requires_confirmation=True,
            requires_explicit_confirmation=True,
            supported=False,
            reason="Future high-risk action is not supported yet.",
        )
    return AdapterActionPolicy(
        action=action,
        category=UNKNOWN,
        read_only=False,
        mutating=False,
        sensitive=False,
        future_high_risk=False,
        requires_confirmation=False,
        requires_explicit_confirmation=False,
        supported=False,
        reason=f"Unsupported adapter action: {action}",
    )


def evaluate_action_permission(
    action: str,
    allow_mutation: bool = False,
    explicit_confirmation: bool = False,
) -> PermissionDecision:
    policy = get_action_policy(action)

    if policy.category == READ_ONLY:
        return _decision(policy, allowed=True, blocked=False, reason="Read-only action is allowed.")

    if policy.category == SAFE_MUTATION:
        if not allow_mutation:
            return _decision(
                policy,
                allowed=False,
                blocked=False,
                reason="Confirmation required before mutating action.",
            )
        return _decision(
            policy,
            allowed=True,
            blocked=False,
            reason="Confirmed mutating action is allowed.",
        )

    if policy.category == SENSITIVE_MUTATION:
        if not allow_mutation:
            return _decision(
                policy,
                allowed=False,
                blocked=False,
                reason="Explicit confirmation required before sensitive action.",
            )
        if not explicit_confirmation:
            return _decision(
                policy,
                allowed=False,
                blocked=False,
                reason="Explicit confirmation required for sensitive action.",
            )
        return _decision(
            policy,
            allowed=True,
            blocked=False,
            reason="Explicitly confirmed sensitive action is allowed.",
        )

    if policy.category == FUTURE_HIGH_RISK:
        return _decision(
            policy,
            allowed=False,
            blocked=True,
            reason="Future high-risk action is not supported yet.",
        )

    return _decision(
        policy,
        allowed=False,
        blocked=True,
        reason=f"Unsupported or unknown adapter action: {action}",
    )


def is_read_only_action(action: str) -> bool:
    return get_action_policy(action).read_only


def is_mutating_action(action: str) -> bool:
    return get_action_policy(action).mutating


def is_sensitive_action(action: str) -> bool:
    return get_action_policy(action).sensitive


def is_supported_action(action: str) -> bool:
    return get_action_policy(action).supported


def _decision(
    policy: AdapterActionPolicy,
    allowed: bool,
    blocked: bool,
    reason: str,
) -> PermissionDecision:
    return PermissionDecision(
        action=policy.action,
        allowed=allowed,
        category=policy.category,
        read_only=policy.read_only,
        mutating=policy.mutating,
        requires_confirmation=policy.requires_confirmation,
        requires_explicit_confirmation=policy.requires_explicit_confirmation,
        blocked=blocked,
        reason=reason,
        policy=policy,
    )
