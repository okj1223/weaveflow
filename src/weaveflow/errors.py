"""Weaveflow-specific exceptions for normal workflow errors."""

from __future__ import annotations


class WeaveflowError(Exception):
    """Base class for user-facing Weaveflow errors."""


class WorkspaceNotFoundError(WeaveflowError):
    """Raised when an operation needs an initialized workspace."""


class TaskNotFoundError(WeaveflowError):
    """Raised when a task directory or spec file cannot be found."""


class MissingPlanError(WeaveflowError):
    """Raised when a worker brief is requested before planning."""


class MissingResultFileError(WeaveflowError):
    """Raised when an attachment source file cannot be found."""


class UnsupportedWorkerError(WeaveflowError):
    """Raised when a worker brief target is not supported."""


class InvalidVerificationStatusError(WeaveflowError):
    """Raised when a manual verification status is not accepted."""


class InvalidTaskRequestError(WeaveflowError):
    """Raised when a task request cannot be turned into a task."""


ProjectOpsError = WeaveflowError
