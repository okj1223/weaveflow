"""Local Weaveflow adapter confirmation flow demo.

Run with:

    python3 examples/adapter_confirmation_demo.py

The demo uses a temporary workspace and does not modify the repository's real
.weaveflow directory.
"""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from weaveflow.adapters import WeaveflowServiceAdapter  # noqa: E402
from weaveflow.adapters.confirmation import (  # noqa: E402
    confirm_request,
    prepare_confirmation,
    reject_request,
)


def render_state(label: str, state, response=None) -> str:
    parts = [
        label,
        f"required={state.required}",
        f"confirmed={state.confirmed}",
        f"action={state.action}",
    ]
    if response is not None:
        parts.append(f"adapter_ok={response.ok}")
        if response.error_type:
            parts.append(f"error_type={response.error_type}")
    return " | ".join(parts)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        adapter = WeaveflowServiceAdapter(root)

        status_state = prepare_confirmation("status")
        status_response = adapter.handle(status_state.request)
        print(render_state("status", status_state, status_response))

        init_state = prepare_confirmation("init workspace")
        print(render_state("init workspace pending", init_state))

        rejected_init = reject_request(init_state)
        print(render_state("rejected init workspace", rejected_init))
        print(f"workspace_exists_after_reject={(root / '.weaveflow').exists()}")

        confirmed_init = confirm_request(init_state)
        init_response = adapter.handle(confirmed_init.request)
        print(render_state("confirmed init workspace", confirmed_init, init_response))

        create_state = prepare_confirmation("create task Confirmation demo task")
        confirmed_create = confirm_request(create_state)
        create_response = adapter.handle(confirmed_create.request)
        task_id = create_response.data.get("id") if create_response.data else None
        print(
            render_state("confirmed create task", confirmed_create, create_response)
            + f" | task_id={task_id}"
        )

        doctor_state = prepare_confirmation("doctor")
        doctor_response = adapter.handle(doctor_state.request)
        healthy = doctor_response.data.get("healthy") if doctor_response.data else None
        print(render_state("doctor", doctor_state, doctor_response) + f" | healthy={healthy}")


if __name__ == "__main__":
    main()
