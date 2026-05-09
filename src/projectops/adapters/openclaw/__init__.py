"""Placeholder OpenClaw adapter skeleton.

This package does not import or integrate real OpenClaw.
"""

from projectops.adapters.openclaw.adapter import OpenClawAdapter
from projectops.adapters.openclaw.models import OpenClawMessage, OpenClawResponse
from projectops.adapters.openclaw.normalization import (
    OpenClawPayloadNormalizationError,
    normalize_openclaw_message_payload,
    openclaw_response_to_payload,
)
from projectops.adapters.openclaw.session_store import OpenClawSessionStore

__all__ = [
    "OpenClawAdapter",
    "OpenClawMessage",
    "OpenClawPayloadNormalizationError",
    "OpenClawResponse",
    "OpenClawSessionStore",
    "normalize_openclaw_message_payload",
    "openclaw_response_to_payload",
]
