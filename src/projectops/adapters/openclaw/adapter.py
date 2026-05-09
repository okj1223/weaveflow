"""Placeholder OpenClaw adapter built on the local ProjectOps adapter pipeline."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from projectops.adapters.confirmation import is_confirmation_response
from projectops.adapters.events import event_from_turn_result
from projectops.adapters.renderers import render_event_as_text
from projectops.adapters.session import AdapterTurnResult
from projectops.adapters.openclaw.models import OpenClawMessage, OpenClawResponse
from projectops.adapters.openclaw.session_store import OpenClawSessionStore


class OpenClawAdapter:
    """Route OpenClaw-like messages through the local ProjectOps adapter pipeline."""

    def __init__(
        self,
        root: Path,
        session_store: Optional[OpenClawSessionStore] = None,
    ) -> None:
        self.root = root
        self.session_store = session_store or OpenClawSessionStore()

    def session_key_for(self, message: OpenClawMessage) -> str:
        parts = [message.channel_id, message.user_id]
        if message.thread_id:
            parts.append(message.thread_id)
        return ":".join(parts)

    def handle_message(self, message: OpenClawMessage) -> OpenClawResponse:
        session_key = self.session_key_for(message)
        session = self.session_store.get_or_create_session(session_key, self.root)
        confirmation = is_confirmation_response(message.text)

        if confirmation is True:
            pending_request_id = self.session_store.get_latest_pending(session_key)
            if pending_request_id is None:
                turn = self._pending_not_found_turn(message.message_id)
            else:
                turn = session.confirm(pending_request_id)
                self.session_store.clear_latest_pending(session_key)
        elif confirmation is False:
            pending_request_id = self.session_store.get_latest_pending(session_key)
            if pending_request_id is None:
                turn = self._pending_not_found_turn(message.message_id)
            else:
                turn = session.reject(pending_request_id)
                self.session_store.clear_latest_pending(session_key)
        else:
            turn = session.handle_text(message.text, request_id=message.message_id)
            if turn.state == "pending_confirmation":
                self.session_store.set_latest_pending(session_key, turn.request_id)

        event = event_from_turn_result(turn)
        rendered_text = render_event_as_text(event, style="chat")
        return OpenClawResponse(
            channel_id=message.channel_id,
            thread_id=message.thread_id,
            reply_to_message_id=message.message_id,
            text=rendered_text,
            event_type=event.event_type,
            request_id=event.request_id,
            requires_confirmation=turn.state == "pending_confirmation",
            ok=turn.ok,
            error_type=turn.error_type,
            metadata={
                "session_key": session_key,
                "action": turn.action,
                "state": turn.state,
            },
        )

    def _pending_not_found_turn(self, request_id: str) -> AdapterTurnResult:
        message = "Pending confirmation not found."
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
