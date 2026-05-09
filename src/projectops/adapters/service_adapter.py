"""Service-backed adapter dispatcher for ProjectOps operations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from projectops import service
from projectops.adapters.base import AdapterRequest, AdapterResponse
from projectops.errors import ProjectOpsError
from projectops.json_io import to_jsonable


READ_ONLY_ACTIONS = frozenset({"status", "list_tasks", "doctor", "show_task"})
MUTATING_ACTIONS = frozenset(
    {
        "init_workspace",
        "create_task",
        "create_plan",
        "create_worker_brief",
        "attach_result",
        "verify_task",
        "create_final_report",
        "propose_memory_update",
    }
)
SUPPORTED_ACTIONS = READ_ONLY_ACTIONS | MUTATING_ACTIONS


class InvalidAdapterRequestError(Exception):
    """Raised when an adapter request is missing required parameters."""


class ProjectOpsServiceAdapter:
    """Translate adapter requests into ProjectOps service function calls."""

    def __init__(self, root: Path):
        self.root = root

    def handle(self, request: AdapterRequest) -> AdapterResponse:
        action = request.action
        read_only = action in READ_ONLY_ACTIONS

        if action not in SUPPORTED_ACTIONS:
            return self._error(
                request,
                read_only=False,
                error_type="UnsupportedAction",
                error_message=f"Unsupported adapter action: {action}",
            )

        if not read_only and not request.allow_mutation:
            return self._error(
                request,
                read_only=False,
                error_type="MutationNotAllowed",
                error_message=(
                    f"Mutation not allowed for adapter action: {action}. "
                    "Set allow_mutation=True to run this action."
                ),
            )

        try:
            data = self._dispatch(request)
        except InvalidAdapterRequestError as error:
            return self._error(
                request,
                read_only=read_only,
                error_type="InvalidAdapterRequest",
                error_message=str(error),
            )
        except ProjectOpsError as error:
            return self._error(
                request,
                read_only=read_only,
                error_type=error.__class__.__name__,
                error_message=str(error),
            )
        except Exception:
            return self._error(
                request,
                read_only=read_only,
                error_type="UnexpectedAdapterError",
                error_message="Unexpected adapter error while handling request.",
            )

        return AdapterResponse(
            ok=True,
            action=action,
            message=f"Adapter action succeeded: {action}",
            data=data,
            error_type=None,
            error_message=None,
            read_only=read_only,
            request_id=request.request_id,
        )

    def _dispatch(self, request: AdapterRequest) -> dict[str, Any]:
        action = request.action
        params = request.params

        if action == "status":
            return self._data(service.get_status(self.root))
        if action == "list_tasks":
            tasks = service.list_tasks(self.root)
            return self._data({"tasks": tasks, "count": len(tasks)})
        if action == "doctor":
            return self._data(service.doctor_workspace(self.root))
        if action == "show_task":
            task_id = self._required_param(request, "task_id")
            return self._data(service.show_task(self.root, str(task_id)))
        if action == "init_workspace":
            return self._data(service.init_workspace(self.root))
        if action == "create_task":
            user_request = self._required_param(request, "user_request")
            return self._data(service.create_task(self.root, str(user_request)))
        if action == "create_plan":
            task_id = self._required_param(request, "task_id")
            return self._data(service.create_plan(self.root, str(task_id)))
        if action == "create_worker_brief":
            task_id = self._required_param(request, "task_id")
            worker = str(params.get("worker", "codex"))
            path = service.create_worker_brief(self.root, str(task_id), worker)
            return self._data({"path": path})
        if action == "attach_result":
            task_id = self._required_param(request, "task_id")
            result_path = self._required_param(request, "result_path")
            artifact = service.attach_result(self.root, str(task_id), Path(result_path))
            return self._data(artifact)
        if action == "verify_task":
            task_id = self._required_param(request, "task_id")
            status = self._required_param(request, "status")
            note = self._required_param(request, "note")
            record = service.verify_task(self.root, str(task_id), str(status), str(note))
            return self._data(record)
        if action == "create_final_report":
            task_id = self._required_param(request, "task_id")
            path = service.create_final_report(self.root, str(task_id))
            return self._data({"path": path})
        if action == "propose_memory_update":
            task_id = self._required_param(request, "task_id")
            path = service.propose_memory_update(self.root, str(task_id))
            return self._data({"path": path})

        raise InvalidAdapterRequestError(f"Unsupported adapter action: {action}")

    def _required_param(self, request: AdapterRequest, name: str) -> Any:
        if name not in request.params or request.params[name] is None:
            raise InvalidAdapterRequestError(
                f"Missing required parameter for {request.action}: {name}"
            )
        return request.params[name]

    def _data(self, value: Any) -> dict[str, Any]:
        jsonable = to_jsonable(value)
        if isinstance(jsonable, dict):
            return jsonable
        return {"value": jsonable}

    def _error(
        self,
        request: AdapterRequest,
        *,
        read_only: bool,
        error_type: str,
        error_message: str,
    ) -> AdapterResponse:
        return AdapterResponse(
            ok=False,
            action=request.action,
            message=error_message,
            data=None,
            error_type=error_type,
            error_message=error_message,
            read_only=read_only,
            request_id=request.request_id,
        )
