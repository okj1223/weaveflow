"""Reusable in-memory adapter session store."""

from __future__ import annotations

from pathlib import Path

from weaveflow.adapters.session import AdapterSession
from weaveflow.adapters.service_adapter import WeaveflowServiceAdapter


class AdapterSessionStore:
    """Keep adapter sessions and pending request IDs in memory."""

    def __init__(self) -> None:
        self._sessions: dict[str, AdapterSession] = {}
        self._latest_pending: dict[str, str] = {}

    def get_or_create_session(self, session_key: str, root: Path) -> AdapterSession:
        self._validate_session_key(session_key)
        if session_key not in self._sessions:
            self._sessions[session_key] = AdapterSession(WeaveflowServiceAdapter(root))
        return self._sessions[session_key]

    def has_session(self, session_key: str) -> bool:
        self._validate_session_key(session_key)
        return session_key in self._sessions

    def set_latest_pending(self, session_key: str, request_id: str) -> None:
        self._validate_session_key(session_key)
        self._latest_pending[session_key] = request_id

    def get_latest_pending(self, session_key: str) -> str | None:
        self._validate_session_key(session_key)
        return self._latest_pending.get(session_key)

    def clear_latest_pending(self, session_key: str) -> None:
        self._validate_session_key(session_key)
        self._latest_pending.pop(session_key, None)

    def list_session_keys(self) -> list[str]:
        return sorted(self._sessions.keys())

    def clear_session(self, session_key: str) -> None:
        self._validate_session_key(session_key)
        self._sessions.pop(session_key, None)
        self._latest_pending.pop(session_key, None)

    def clear_all(self) -> None:
        self._sessions.clear()
        self._latest_pending.clear()

    def _validate_session_key(self, session_key: str) -> None:
        if not isinstance(session_key, str) or not session_key.strip():
            raise ValueError("session_key must be a non-empty string.")


InMemoryAdapterSessionStore = AdapterSessionStore
