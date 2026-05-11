"""Local Weaveflow adapter intent mapping demo.

Run with:

    python3 examples/adapter_intent_mapping_demo.py

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
from weaveflow.adapters.intent_mapper import map_text_to_adapter_request  # noqa: E402


def run_command(
    adapter: WeaveflowServiceAdapter,
    text: str,
    *,
    allow_mutation: bool = False,
    execute: bool = True,
) -> None:
    result = map_text_to_adapter_request(text, allow_mutation=allow_mutation)
    parts = [
        f"input={text!r}",
        f"mapping_ok={result.ok}",
        f"action={result.action}",
        f"requires_confirmation={result.requires_confirmation}",
    ]
    if result.error_type:
        parts.append(f"mapping_error={result.error_type}")

    if execute and result.request is not None:
        response = adapter.handle(result.request)
        parts.append(f"response_ok={response.ok}")
        if response.error_type:
            parts.append(f"response_error={response.error_type}")

    print(" | ".join(parts))


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        adapter = WeaveflowServiceAdapter(Path(temp_dir))

        run_command(adapter, "status")
        run_command(adapter, "init workspace", allow_mutation=True)
        run_command(adapter, "create task Draft from external text")
        run_command(
            adapter,
            "create task Implement deterministic mapper",
            allow_mutation=True,
        )
        run_command(adapter, "plan TASK-0001", allow_mutation=True)
        run_command(adapter, "brief TASK-0001", allow_mutation=True)
        run_command(adapter, "list tasks")
        run_command(adapter, "doctor")
        run_command(adapter, "do something mysterious")


if __name__ == "__main__":
    main()
