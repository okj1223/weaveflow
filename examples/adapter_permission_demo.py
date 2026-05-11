"""Local adapter permission policy demo.

Run with:

    python3 examples/adapter_permission_demo.py
"""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from weaveflow.adapters import evaluate_action_permission, get_action_policy  # noqa: E402


def render(action: str, allow_mutation: bool = False, explicit: bool = False) -> str:
    policy = get_action_policy(action)
    decision = evaluate_action_permission(
        action,
        allow_mutation=allow_mutation,
        explicit_confirmation=explicit,
    )
    return " | ".join(
        [
            f"action={action}",
            f"category={policy.category}",
            f"allowed={decision.allowed}",
            f"blocked={decision.blocked}",
            f"requires_confirmation={decision.requires_confirmation}",
            f"requires_explicit_confirmation={decision.requires_explicit_confirmation}",
            f"reason={decision.reason}",
        ]
    )


def main() -> None:
    print(render("status"))
    print(render("create_task"))
    print(render("create_task", allow_mutation=True))
    print(render("verify_task", allow_mutation=True))
    print(render("verify_task", allow_mutation=True, explicit=True))
    print(render("auto_run_codex", allow_mutation=True, explicit=True))
    print(render("unknown_action"))


if __name__ == "__main__":
    main()
