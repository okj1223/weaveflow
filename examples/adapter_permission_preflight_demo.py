"""Demo adapter permission preflight decisions."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from weaveflow.adapters.permission_preflight import (  # noqa: E402
    PermissionPreflightResult,
    preflight_openclaw_payload,
    preflight_text_command,
)


def print_result(label: str, result: PermissionPreflightResult) -> None:
    error = f" error_type={result.error_type}" if result.error_type else ""
    print(
        f"{label}: source={result.source} action={result.action} "
        f"category={result.category} allowed={result.allowed} "
        f"blocked={result.blocked} should_route={result.should_route} "
        f"should_ask_confirmation={result.should_ask_confirmation} "
        f"should_ask_explicit_confirmation={result.should_ask_explicit_confirmation}"
        f"{error}"
    )


def payload(content: str, message_id: str = "m1") -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": content,
        "createdAt": "2026-05-10T00:00:00Z",
    }


def main() -> None:
    examples = [
        (
            "status",
            preflight_text_command("status"),
        ),
        (
            "create without mutation",
            preflight_text_command("create task Investigate auth bug"),
        ),
        (
            "create with mutation",
            preflight_text_command(
                "create task Investigate auth bug",
                allow_mutation=True,
            ),
        ),
        (
            "verify without explicit",
            preflight_text_command(
                "verify TASK-0001 passed manual check",
                allow_mutation=True,
            ),
        ),
        (
            "verify with explicit",
            preflight_text_command(
                "verify TASK-0001 passed manual check",
                allow_mutation=True,
                explicit_confirmation=True,
            ),
        ),
        (
            "auto run codex",
            preflight_text_command("auto run codex"),
        ),
        (
            "raw list tasks",
            preflight_openclaw_payload(payload("list tasks", "m-list")),
        ),
        (
            "bad payload",
            preflight_openclaw_payload({"messageId": "bad-1"}),
        ),
    ]

    for label, result in examples:
        print_result(label, result)


if __name__ == "__main__":
    main()
