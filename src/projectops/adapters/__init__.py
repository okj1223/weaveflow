"""Internal adapter boundary for ProjectOps integrations."""

from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.adapters.confirmation import (
    ConfirmationState,
    confirm_request,
    is_confirmation_response,
    prepare_confirmation,
    reject_request,
)
from projectops.adapters.events import (
    AdapterEvent,
    AdapterTranscript,
    event_from_turn_result,
    event_to_display_line,
    transcript_from_turns,
)
from projectops.adapters.intent_mapper import IntentMappingResult, map_text_to_adapter_request
from projectops.adapters.renderers import (
    render_event_as_text,
    render_event_summary,
    render_transcript_as_text,
)
from projectops.adapters.session import AdapterSession, AdapterTurnResult
from projectops.adapters.session_store import (
    AdapterSessionStore,
    InMemoryAdapterSessionStore,
)
from projectops.adapters.service_adapter import ProjectOpsServiceAdapter

__all__ = [
    "AdapterEvent",
    "AdapterRequest",
    "AdapterResponse",
    "AdapterSession",
    "AdapterSessionStore",
    "AdapterTranscript",
    "AdapterTurnResult",
    "ConfirmationState",
    "InMemoryAdapterSessionStore",
    "IntentMappingResult",
    "ProjectOpsServiceAdapter",
    "confirm_request",
    "event_from_turn_result",
    "event_to_display_line",
    "is_confirmation_response",
    "map_text_to_adapter_request",
    "prepare_confirmation",
    "render_event_as_text",
    "render_event_summary",
    "render_transcript_as_text",
    "reject_request",
    "transcript_from_turns",
]
