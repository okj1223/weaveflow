"""In-memory session store for the placeholder OpenClaw adapter."""

from __future__ import annotations

from projectops.adapters.session_store import AdapterSessionStore


class OpenClawSessionStore(AdapterSessionStore):
    """OpenClaw-facing alias for the generic in-memory adapter session store."""
