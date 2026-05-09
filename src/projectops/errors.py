"""ProjectOps-specific exceptions for normal workflow errors."""

from __future__ import annotations


class ProjectOpsError(Exception):
    """Base class for user-facing ProjectOps errors."""


class WorkspaceNotFoundError(ProjectOpsError):
    """Raised when an operation needs an initialized workspace."""


class TaskNotFoundError(ProjectOpsError):
    """Raised when a task directory or spec file cannot be found."""


class MissingPlanError(ProjectOpsError):
    """Raised when a worker brief is requested before planning."""


class MissingResultFileError(ProjectOpsError):
    """Raised when an attachment source file cannot be found."""


class UnsupportedWorkerError(ProjectOpsError):
    """Raised when a worker brief target is not supported."""


class InvalidVerificationStatusError(ProjectOpsError):
    """Raised when a manual verification status is not accepted."""


class InvalidTaskRequestError(ProjectOpsError):
    """Raised when a task request cannot be turned into a task."""
