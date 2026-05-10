"""Demo explicit confirmation helpers for sensitive adapter actions."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters.explicit_confirmation import (  # noqa: E402
    check_explicit_confirmation,
    create_explicit_confirmation_prompt,
)
from projectops.adapters.permission_preflight import (  # noqa: E402
    preflight_openclaw_payload,
)


def payload() -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": "m-verify",
        "content": "verify TASK-0001 passed manual check",
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def main() -> None:
    preflight = preflight_openclaw_payload(
        payload(),
        allow_mutation=True,
        explicit_confirmation=False,
        bridge_request_id="bridge-verify",
    )
    prompt = create_explicit_confirmation_prompt(preflight)

    print(f"action: {prompt.action}")
    print(f"requires_explicit_confirmation: {preflight.requires_explicit_confirmation}")
    print(f"confirmation_phrase: {prompt.confirmation_phrase}")
    print(f"instruction: {prompt.instruction}")

    wrong = check_explicit_confirmation("yes", prompt)
    print(f"yes mismatch: matched={wrong.matched} error_type={wrong.error_type}")

    correct = check_explicit_confirmation(prompt.confirmation_phrase, prompt)
    print(f"correct matched: matched={correct.matched} ok={correct.ok}")
    print("executed: False")


if __name__ == "__main__":
    main()
