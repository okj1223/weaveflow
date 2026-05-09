"""Placeholder OpenClaw adapter skeleton.

This package does not import or integrate real OpenClaw.
"""

from projectops.adapters.openclaw.adapter import OpenClawAdapter
from projectops.adapters.openclaw.models import OpenClawMessage, OpenClawResponse
from projectops.adapters.openclaw.session_store import OpenClawSessionStore

__all__ = [
    "OpenClawAdapter",
    "OpenClawMessage",
    "OpenClawResponse",
    "OpenClawSessionStore",
]
