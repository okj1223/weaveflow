"""In-memory session store for the placeholder OpenClaw adapter."""

from __future__ import annotations

from pathlib import Path

from projectops.adapters.session import AdapterSession
from projectops.adapters.service_adapter import ProjectOpsServiceAdapter


class OpenClawSessionStore:
    """Keep adapter sessions and pending request IDs in memory."""

    def __init__(self) -> None:
        self._sessions: dict[str, AdapterSession] = {}
        self._latest_pending: dict[str, str] = {}

    def get_or_create_session(self, session_key: str, root: Path) -> AdapterSession:
        if session_key not in self._sessions:
            self._sessions[session_key] = AdapterSession(ProjectOpsServiceAdapter(root))
        return self._sessions[session_key]

    def set_latest_pending(self, session_key: str, request_id: str) -> None:
        self._latest_pending[session_key] = request_id

    def get_latest_pending(self, session_key: str) -> str | None:
        return self._latest_pending.get(session_key)

    def clear_latest_pending(self, session_key: str) -> None:
        self._latest_pending.pop(session_key, None)
