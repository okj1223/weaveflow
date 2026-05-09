"""Local ProjectOps adapter usage demo.

Run with:

    python3 examples/adapter_usage_demo.py

The demo uses a temporary workspace and does not modify the repository's real
.projectops directory.
"""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from projectops.adapters import AdapterRequest, AdapterResponse, ProjectOpsServiceAdapter  # noqa: E402


def render(label: str, response: AdapterResponse) -> str:
    parts = [label, f"ok={response.ok}"]
    data = response.data or {}

    if response.error_type:
        parts.append(f"error_type={response.error_type}")
    if "workspace_exists" in data:
        parts.append(f"workspace_exists={data['workspace_exists']}")
    if "id" in data:
        parts.append(f"task_id={data['id']}")
    if "count" in data:
        parts.append(f"count={data['count']}")
    if "healthy" in data:
        parts.append(f"healthy={data['healthy']}")

    return " | ".join(parts)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        adapter = ProjectOpsServiceAdapter(root)

        response = adapter.handle(AdapterRequest(action="status"))
        print(render("status before init", response))

        response = adapter.handle(
            AdapterRequest(action="init_workspace", allow_mutation=True)
        )
        print(render("init_workspace", response))

        response = adapter.handle(AdapterRequest(action="status"))
        print(render("status after init", response))

        response = adapter.handle(
            AdapterRequest(
                action="create_task",
                params={"user_request": "Adapter usage demo task"},
                allow_mutation=True,
            )
        )
        print(render("create_task", response))
        task_id = response.data["id"] if response.data else "TASK-0001"

        response = adapter.handle(
            AdapterRequest(
                action="create_plan",
                params={"task_id": task_id},
                allow_mutation=True,
            )
        )
        print(render("create_plan", response))

        response = adapter.handle(
            AdapterRequest(
                action="create_worker_brief",
                params={"task_id": task_id, "worker": "codex"},
                allow_mutation=True,
            )
        )
        print(render("create_worker_brief", response))

        response = adapter.handle(AdapterRequest(action="list_tasks"))
        print(render("list_tasks", response))

        response = adapter.handle(AdapterRequest(action="doctor"))
        print(render("doctor", response))

        response = adapter.handle(
            AdapterRequest(
                action="create_task",
                params={"user_request": "This mutation should be blocked"},
            )
        )
        print(render("blocked mutation", response))

        response = adapter.handle(AdapterRequest(action="does_not_exist"))
        print(render("unsupported action", response))


if __name__ == "__main__":
    main()
