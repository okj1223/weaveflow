"""Placeholder OpenClaw adapter skeleton.

This package does not import or integrate real OpenClaw.
"""

from weaveflow.adapters.openclaw.adapter import OpenClawAdapter
from weaveflow.adapters.openclaw.models import OpenClawMessage, OpenClawResponse
from weaveflow.adapters.openclaw.normalization import (
    OpenClawPayloadNormalizationError,
    normalize_openclaw_message_payload,
    openclaw_response_to_payload,
)
from weaveflow.adapters.openclaw.session_store import OpenClawSessionStore

__all__ = [
    "OpenClawAdapter",
    "OpenClawMessage",
    "OpenClawPayloadNormalizationError",
    "OpenClawResponse",
    "OpenClawSessionStore",
    "normalize_openclaw_message_payload",
    "openclaw_response_to_payload",
]
