"""Internal adapter boundary for ProjectOps integrations."""

from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.adapters.intent_mapper import IntentMappingResult, map_text_to_adapter_request
from projectops.adapters.service_adapter import ProjectOpsServiceAdapter

__all__ = [
    "AdapterRequest",
    "AdapterResponse",
    "IntentMappingResult",
    "ProjectOpsServiceAdapter",
    "map_text_to_adapter_request",
]
