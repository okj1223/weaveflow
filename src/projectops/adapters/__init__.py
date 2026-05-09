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
from projectops.adapters.permissions import (
    AdapterActionPolicy,
    PermissionDecision,
    evaluate_action_permission,
    get_action_policy,
    is_mutating_action,
    is_read_only_action,
    is_sensitive_action,
    is_supported_action,
)
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
    "AdapterActionPolicy",
    "AdapterRequest",
    "AdapterResponse",
    "AdapterSession",
    "AdapterSessionStore",
    "AdapterTranscript",
    "AdapterTurnResult",
    "ConfirmationState",
    "InMemoryAdapterSessionStore",
    "IntentMappingResult",
    "PermissionDecision",
    "ProjectOpsServiceAdapter",
    "confirm_request",
    "evaluate_action_permission",
    "event_from_turn_result",
    "event_to_display_line",
    "get_action_policy",
    "is_confirmation_response",
    "is_mutating_action",
    "is_read_only_action",
    "is_sensitive_action",
    "is_supported_action",
    "map_text_to_adapter_request",
    "prepare_confirmation",
    "render_event_as_text",
    "render_event_summary",
    "render_transcript_as_text",
    "reject_request",
    "transcript_from_turns",
]
