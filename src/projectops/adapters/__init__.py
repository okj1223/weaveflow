"""Internal adapter boundary for ProjectOps integrations."""

from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.adapters.channel_rendering import (
    ChannelRenderPolicy,
    get_channel_render_policy,
    render_event_for_channel,
    render_transcript_for_channel,
)
from projectops.adapters.confirmation import (
    ConfirmationState,
    confirm_request,
    is_confirmation_response,
    prepare_confirmation,
    reject_request,
)
from projectops.adapters.diagnostics import (
    DIAGNOSTIC_VERSION,
    DiagnosticEvent,
    DiagnosticWriter,
    create_diagnostic_event,
    diagnostic_event_to_json_line,
    sanitize_diagnostic_metadata,
)
from projectops.adapters.events import (
    AdapterEvent,
    AdapterTranscript,
    event_from_turn_result,
    event_to_display_line,
    transcript_from_turns,
)
from projectops.adapters.explicit_confirmation import (
    ExplicitConfirmationCheck,
    ExplicitConfirmationPrompt,
    build_explicit_confirmation_phrase,
    check_explicit_confirmation,
    create_explicit_confirmation_prompt,
    is_explicit_confirmation_required,
    summarize_explicit_confirmation_prompt,
)
from projectops.adapters.intent_mapper import IntentMappingResult, map_text_to_adapter_request
from projectops.adapters.local_wrapper import (
    LocalBridgeWrapper,
    PendingExplicitConfirmation,
    SESSION_LOSS_MESSAGE,
    WrapperRouteResult,
)
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
from projectops.adapters.permission_preflight import (
    PermissionPreflightResult,
    permission_preflight_result_to_payload,
    preflight_adapter_request,
    preflight_openclaw_payload,
    preflight_text_command,
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
    "ChannelRenderPolicy",
    "ConfirmationState",
    "DIAGNOSTIC_VERSION",
    "DiagnosticEvent",
    "DiagnosticWriter",
    "ExplicitConfirmationCheck",
    "ExplicitConfirmationPrompt",
    "InMemoryAdapterSessionStore",
    "IntentMappingResult",
    "LocalBridgeWrapper",
    "PermissionDecision",
    "PermissionPreflightResult",
    "PendingExplicitConfirmation",
    "ProjectOpsServiceAdapter",
    "SESSION_LOSS_MESSAGE",
    "WrapperRouteResult",
    "build_explicit_confirmation_phrase",
    "check_explicit_confirmation",
    "confirm_request",
    "create_explicit_confirmation_prompt",
    "create_diagnostic_event",
    "diagnostic_event_to_json_line",
    "evaluate_action_permission",
    "event_from_turn_result",
    "event_to_display_line",
    "get_channel_render_policy",
    "get_action_policy",
    "is_confirmation_response",
    "is_explicit_confirmation_required",
    "is_mutating_action",
    "is_read_only_action",
    "is_sensitive_action",
    "is_supported_action",
    "map_text_to_adapter_request",
    "permission_preflight_result_to_payload",
    "preflight_adapter_request",
    "preflight_openclaw_payload",
    "preflight_text_command",
    "prepare_confirmation",
    "render_event_for_channel",
    "render_event_as_text",
    "render_event_summary",
    "render_transcript_for_channel",
    "render_transcript_as_text",
    "reject_request",
    "sanitize_diagnostic_metadata",
    "summarize_explicit_confirmation_prompt",
    "transcript_from_turns",
]
