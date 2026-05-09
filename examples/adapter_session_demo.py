"""Local ProjectOps adapter session lifecycle demo.

Run with:

    python3 examples/adapter_session_demo.py

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

from projectops.adapters import AdapterSession, ProjectOpsServiceAdapter  # noqa: E402


def render(label: str, result) -> str:
    parts = [
        label,
        f"state={result.state}",
        f"ok={result.ok}",
        f"pending={result.pending}",
        f"request_id={result.request_id}",
    ]
    if result.action:
        parts.append(f"action={result.action}")
    if result.error_type:
        parts.append(f"error_type={result.error_type}")
    return " | ".join(parts)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        session = AdapterSession(ProjectOpsServiceAdapter(root))

        status = session.handle_text("status", request_id="demo-status")
        workspace_exists = (
            status.response.data.get("workspace_exists")
            if status.response and status.response.data
            else None
        )
        print(render("status", status) + f" | workspace_exists={workspace_exists}")

        pending_init = session.handle_text("init workspace", request_id="demo-reject")
        print(render("init workspace pending_confirmation", pending_init))

        rejected_init = session.reject("demo-reject")
        print(render("reject init workspace", rejected_init))
        print(f"workspace_exists_after_reject={(root / '.projectops').exists()}")

        session.handle_text("init workspace", request_id="demo-init")
        confirmed_init = session.confirm("demo-init")
        print(render("confirm init workspace", confirmed_init))

        session.handle_text("create task Session demo task", request_id="demo-task")
        confirmed_task = session.confirm("demo-task")
        task_id = (
            confirmed_task.response.data.get("id")
            if confirmed_task.response and confirmed_task.response.data
            else None
        )
        print(render("confirm create task", confirmed_task) + f" | task_id={task_id}")

        tasks = session.handle_text("list tasks", request_id="demo-list")
        count = (
            tasks.response.data.get("count")
            if tasks.response and tasks.response.data
            else None
        )
        print(render("list tasks", tasks) + f" | count={count}")

        doctor = session.handle_text("doctor", request_id="demo-doctor")
        healthy = (
            doctor.response.data.get("healthy")
            if doctor.response and doctor.response.data
            else None
        )
        print(render("doctor", doctor) + f" | healthy={healthy}")

        missing = session.confirm("demo-missing")
        print(render("confirm missing", missing))


if __name__ == "__main__":
    main()
