"""In-memory adapter session lifecycle helpers."""

from __future__ import annotations

from typing import Optional
from uuid import uuid4

from pydantic import BaseModel

from weaveflow.adapters.base import AdapterResponse
from weaveflow.adapters.confirmation import (
    ConfirmationState,
    confirm_request,
    prepare_confirmation,
    reject_request,
)
from weaveflow.adapters.intent_mapper import map_text_to_adapter_request
from weaveflow.adapters.service_adapter import WeaveflowServiceAdapter
from weaveflow.json_io import CONTRACT_VERSION


class AdapterTurnResult(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    request_id: str
    state: str
    message: str
    action: Optional[str] = None
    pending: bool
    response: Optional[AdapterResponse] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None


class AdapterSession:
    """Carry pending confirmation state across adapter turns in memory."""

    def __init__(self, adapter: WeaveflowServiceAdapter):
        self.adapter = adapter
        self._pending: dict[str, ConfirmationState] = {}

    def handle_text(
        self,
        text: str,
        request_id: Optional[str] = None,
        allow_mutation: bool = False,
    ) -> AdapterTurnResult:
        turn_request_id = request_id or self._new_request_id()

        if allow_mutation:
            mapping = map_text_to_adapter_request(
                text,
                allow_mutation=True,
                request_id=turn_request_id,
            )
            if not mapping.ok or mapping.request is None:
                return self._mapping_error(turn_request_id, mapping.error_type, mapping.error_message)
            return self._execute(turn_request_id, mapping.action, mapping.request)

        confirmation = prepare_confirmation(text, request_id=turn_request_id)

        if confirmation.request is None and not confirmation.confirmed:
            return AdapterTurnResult(
                ok=False,
                request_id=turn_request_id,
                state="error",
                message=confirmation.message,
                action=confirmation.action,
                pending=False,
                response=None,
                error_type=self._message_error_type(confirmation.message),
                error_message=confirmation.message,
            )

        if confirmation.required:
            self._pending[turn_request_id] = confirmation
            return AdapterTurnResult(
                ok=True,
                request_id=turn_request_id,
                state="pending_confirmation",
                message=confirmation.message,
                action=confirmation.action,
                pending=True,
                response=None,
                error_type=None,
                error_message=None,
            )

        if confirmation.request is None:
            return AdapterTurnResult(
                ok=False,
                request_id=turn_request_id,
                state="error",
                message="No adapter request available.",
                action=confirmation.action,
                pending=False,
                response=None,
                error_type="InvalidSessionState",
                error_message="No adapter request available.",
            )

        return self._execute(turn_request_id, confirmation.action, confirmation.request)

    def confirm(self, request_id: str) -> AdapterTurnResult:
        pending = self._pending.pop(request_id, None)
        if pending is None:
            return self._pending_not_found(request_id)

        confirmed = confirm_request(pending)
        if confirmed.request is None:
            return AdapterTurnResult(
                ok=False,
                request_id=request_id,
                state="error",
                message=confirmed.message,
                action=confirmed.action,
                pending=False,
                response=None,
                error_type="InvalidSessionState",
                error_message=confirmed.message,
            )

        return self._execute(request_id, confirmed.action, confirmed.request)

    def reject(self, request_id: str) -> AdapterTurnResult:
        pending = self._pending.pop(request_id, None)
        if pending is None:
            return self._pending_not_found(request_id)

        rejected = reject_request(pending)
        return AdapterTurnResult(
            ok=True,
            request_id=request_id,
            state="rejected",
            message=rejected.message,
            action=rejected.action,
            pending=False,
            response=None,
            error_type=None,
            error_message=None,
        )

    def has_pending(self, request_id: str) -> bool:
        return request_id in self._pending

    def list_pending(self) -> list[str]:
        return list(self._pending.keys())

    def _execute(
        self,
        request_id: str,
        action: Optional[str],
        request,
    ) -> AdapterTurnResult:
        response = self.adapter.handle(request)
        if response.ok:
            return AdapterTurnResult(
                ok=True,
                request_id=request_id,
                state="completed",
                message=response.message,
                action=action,
                pending=False,
                response=response,
                error_type=None,
                error_message=None,
            )
        return AdapterTurnResult(
            ok=False,
            request_id=request_id,
            state="error",
            message=response.message,
            action=action,
            pending=False,
            response=response,
            error_type=response.error_type,
            error_message=response.error_message,
        )

    def _pending_not_found(self, request_id: str) -> AdapterTurnResult:
        message = f"Pending confirmation not found: {request_id}"
        return AdapterTurnResult(
            ok=False,
            request_id=request_id,
            state="error",
            message=message,
            action=None,
            pending=False,
            response=None,
            error_type="PendingConfirmationNotFound",
            error_message=message,
        )

    def _mapping_error(
        self,
        request_id: str,
        error_type: Optional[str],
        error_message: Optional[str],
    ) -> AdapterTurnResult:
        message = error_message or "Could not map adapter command."
        return AdapterTurnResult(
            ok=False,
            request_id=request_id,
            state="error",
            message=message,
            action=None,
            pending=False,
            response=None,
            error_type=error_type or "InvalidIntent",
            error_message=message,
        )

    def _message_error_type(self, message: str) -> str:
        if ":" in message:
            return message.split(":", 1)[0]
        return "InvalidIntent"

    def _new_request_id(self) -> str:
        return f"req-{uuid4().hex}"
