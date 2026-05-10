"""In-memory replay protection for explicit confirmation phrases."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.adapters.diagnostics import sanitize_diagnostic_metadata
from projectops.json_io import CONTRACT_VERSION
from projectops.models import utc_now_iso


CONFIRMATION_STATE_PENDING = "pending"
CONFIRMATION_STATE_CONSUMED = "consumed"
CONFIRMATION_STATE_REJECTED = "rejected"
CONFIRMATION_STATE_UNKNOWN = "unknown"

ALLOWED_CONFIRMATION_STATES = {
    CONFIRMATION_STATE_PENDING,
    CONFIRMATION_STATE_CONSUMED,
    CONFIRMATION_STATE_REJECTED,
    CONFIRMATION_STATE_UNKNOWN,
}


class ConfirmationReplayRecord(BaseModel):
    contract_version: str = CONTRACT_VERSION
    key: str
    state: str
    action: Optional[str] = None
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    created_at: str
    updated_at: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConfirmationReplayCheck(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    key: Optional[str] = None
    state: str
    replay_detected: bool
    can_execute: bool
    action: Optional[str] = None
    request_id: Optional[str] = None
    bridge_request_id: Optional[str] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    summary: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConfirmationReplayGuard:
    """Track explicit confirmation state in memory for one wrapper process."""

    def __init__(self) -> None:
        self._records: dict[str, ConfirmationReplayRecord] = {}

    def make_key(
        self,
        *,
        action: str,
        request_id: Optional[str] = None,
        bridge_request_id: Optional[str] = None,
    ) -> str:
        normalized_action = action.strip().lower() or "unknown"
        if bridge_request_id:
            return f"{normalized_action}:bridge:{bridge_request_id}"
        if request_id:
            return f"{normalized_action}:request:{request_id}"
        return f"{normalized_action}:action-only"

    def register_pending(
        self,
        *,
        action: str,
        request_id: Optional[str] = None,
        bridge_request_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> ConfirmationReplayRecord:
        key = self.make_key(
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
        )
        existing = self._records.get(key)
        if existing is not None and existing.state == CONFIRMATION_STATE_CONSUMED:
            return existing

        now = utc_now_iso()
        record = ConfirmationReplayRecord(
            key=key,
            state=CONFIRMATION_STATE_PENDING,
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
            created_at=existing.created_at if existing is not None else now,
            updated_at=now,
            metadata=sanitize_diagnostic_metadata(metadata or {}),
        )
        self._records[key] = record
        return record

    def check_before_execute(
        self,
        *,
        action: str,
        request_id: Optional[str] = None,
        bridge_request_id: Optional[str] = None,
    ) -> ConfirmationReplayCheck:
        key = self.make_key(
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
        )
        record = self._records.get(key)
        if record is None:
            return _check(
                ok=False,
                key=key,
                state=CONFIRMATION_STATE_UNKNOWN,
                replay_detected=False,
                can_execute=False,
                action=action,
                request_id=request_id,
                bridge_request_id=bridge_request_id,
                error_type="PendingConfirmationNotFound",
                error_message="Pending explicit confirmation was not found.",
                summary="Pending explicit confirmation was not found.",
            )

        if record.state == CONFIRMATION_STATE_PENDING:
            return _check(
                ok=True,
                key=key,
                state=record.state,
                replay_detected=False,
                can_execute=True,
                action=record.action,
                request_id=record.request_id,
                bridge_request_id=record.bridge_request_id,
                summary="Pending explicit confirmation can execute.",
                metadata=record.metadata,
            )

        if record.state == CONFIRMATION_STATE_CONSUMED:
            return _check(
                ok=False,
                key=key,
                state=record.state,
                replay_detected=True,
                can_execute=False,
                action=record.action,
                request_id=record.request_id,
                bridge_request_id=record.bridge_request_id,
                error_type="StaleConfirmationReplay",
                error_message="Explicit confirmation was already consumed.",
                summary="Explicit confirmation was already consumed and cannot be replayed.",
                metadata=record.metadata,
            )

        if record.state == CONFIRMATION_STATE_REJECTED:
            return _check(
                ok=False,
                key=key,
                state=record.state,
                replay_detected=True,
                can_execute=False,
                action=record.action,
                request_id=record.request_id,
                bridge_request_id=record.bridge_request_id,
                error_type="RejectedConfirmationReplay",
                error_message="Explicit confirmation was rejected.",
                summary="Explicit confirmation was rejected and cannot be replayed.",
                metadata=record.metadata,
            )

        return _check(
            ok=False,
            key=key,
            state=CONFIRMATION_STATE_UNKNOWN,
            replay_detected=False,
            can_execute=False,
            action=record.action,
            request_id=record.request_id,
            bridge_request_id=record.bridge_request_id,
            error_type="InvalidConfirmationReplayState",
            error_message=f"Invalid confirmation replay state: {record.state}.",
            summary="Explicit confirmation replay state was invalid.",
            metadata=record.metadata,
        )

    def mark_consumed(
        self,
        *,
        action: str,
        request_id: Optional[str] = None,
        bridge_request_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> ConfirmationReplayRecord:
        return self._mark(
            state=CONFIRMATION_STATE_CONSUMED,
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
            metadata=metadata,
        )

    def mark_rejected(
        self,
        *,
        action: str,
        request_id: Optional[str] = None,
        bridge_request_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> ConfirmationReplayRecord:
        return self._mark(
            state=CONFIRMATION_STATE_REJECTED,
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
            metadata=metadata,
        )

    def get_record(self, key: str) -> Optional[ConfirmationReplayRecord]:
        return self._records.get(key)

    def list_records(self) -> list[ConfirmationReplayRecord]:
        return list(self._records.values())

    def clear(self) -> None:
        self._records.clear()

    def _mark(
        self,
        *,
        state: str,
        action: str,
        request_id: Optional[str],
        bridge_request_id: Optional[str],
        metadata: Optional[dict[str, Any]],
    ) -> ConfirmationReplayRecord:
        if state not in {CONFIRMATION_STATE_CONSUMED, CONFIRMATION_STATE_REJECTED}:
            raise ValueError(f"Unsupported replay mark state: {state}.")

        key = self.make_key(
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
        )
        existing = self._records.get(key)
        now = utc_now_iso()
        existing_metadata = existing.metadata if existing is not None else {}
        merged_metadata = dict(existing_metadata)
        merged_metadata.update(metadata or {})

        record = ConfirmationReplayRecord(
            key=key,
            state=state,
            action=action,
            request_id=request_id,
            bridge_request_id=bridge_request_id,
            created_at=existing.created_at if existing is not None else now,
            updated_at=now,
            metadata=sanitize_diagnostic_metadata(merged_metadata),
        )
        self._records[key] = record
        return record


def _check(
    *,
    ok: bool,
    key: Optional[str],
    state: str,
    replay_detected: bool,
    can_execute: bool,
    action: Optional[str],
    request_id: Optional[str],
    bridge_request_id: Optional[str],
    summary: str,
    error_type: Optional[str] = None,
    error_message: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> ConfirmationReplayCheck:
    return ConfirmationReplayCheck(
        ok=ok,
        key=key,
        state=state,
        replay_detected=replay_detected,
        can_execute=can_execute,
        action=action,
        request_id=request_id,
        bridge_request_id=bridge_request_id,
        error_type=error_type,
        error_message=error_message,
        summary=summary,
        metadata=sanitize_diagnostic_metadata(metadata or {}),
    )
