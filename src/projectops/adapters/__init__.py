"""Internal adapter boundary for ProjectOps integrations."""

from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.adapters.confirmation import (
    ConfirmationState,
    confirm_request,
    is_confirmation_response,
    prepare_confirmation,
    reject_request,
)
from projectops.adapters.intent_mapper import IntentMappingResult, map_text_to_adapter_request
from projectops.adapters.session import AdapterSession, AdapterTurnResult
from projectops.adapters.service_adapter import ProjectOpsServiceAdapter

__all__ = [
    "AdapterRequest",
    "AdapterResponse",
    "AdapterSession",
    "AdapterTurnResult",
    "ConfirmationState",
    "IntentMappingResult",
    "ProjectOpsServiceAdapter",
    "confirm_request",
    "is_confirmation_response",
    "map_text_to_adapter_request",
    "prepare_confirmation",
    "reject_request",
]
