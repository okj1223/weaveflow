"""Adapter event and transcript models for UI rendering."""

from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from projectops.adapters.session import AdapterTurnResult
from projectops.json_io import CONTRACT_VERSION, to_jsonable
from projectops.models import utc_now_iso


STATE_EVENT_MAP = {
    "completed": ("turn_completed", "info"),
    "pending_confirmation": ("pending_confirmation", "warning"),
    "rejected": ("turn_rejected", "info"),
    "error": ("turn_error", "error"),
}


class AdapterEvent(BaseModel):
    contract_version: str = CONTRACT_VERSION
    event_id: str = Field(default_factory=lambda: f"evt-{uuid4().hex}")
    request_id: str
    event_type: str
    level: str
    state: str
    action: Optional[str] = None
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    created_at: str = Field(default_factory=utc_now_iso)


class AdapterTranscript(BaseModel):
    contract_version: str = CONTRACT_VERSION
    session_id: str
    events: list[AdapterEvent] = Field(default_factory=list)

    def add_event(self, event: AdapterEvent) -> None:
        self.events.append(event)

    def to_dict(self) -> dict[str, Any]:
        return to_jsonable(self)


def event_from_turn_result(turn: AdapterTurnResult) -> AdapterEvent:
    event_type, level = STATE_EVENT_MAP.get(turn.state, ("turn_error", "error"))
    data: dict[str, Any] = {
        "ok": turn.ok,
        "pending": turn.pending,
    }
    if turn.response is not None:
        data["response"] = to_jsonable(turn.response)

    return AdapterEvent(
        request_id=turn.request_id,
        event_type=event_type,
        level=level,
        state=turn.state,
        action=turn.action,
        message=turn.message,
        data=to_jsonable(data),
        error_type=turn.error_type,
        error_message=turn.error_message,
    )


def transcript_from_turns(
    session_id: str,
    turns: list[AdapterTurnResult],
) -> AdapterTranscript:
    return AdapterTranscript(
        session_id=session_id,
        events=[event_from_turn_result(turn) for turn in turns],
    )


def event_to_display_line(event: AdapterEvent) -> str:
    action = event.action or "none"
    return (
        f"{event.event_type} | {event.level} | {event.state} | "
        f"{action} | {event.message}"
    )
