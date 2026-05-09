"""Internal adapter boundary for ProjectOps integrations."""

from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.adapters.service_adapter import ProjectOpsServiceAdapter

__all__ = [
    "AdapterRequest",
    "AdapterResponse",
    "ProjectOpsServiceAdapter",
]
