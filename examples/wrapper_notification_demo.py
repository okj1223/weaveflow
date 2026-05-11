"""Demo restart-aware wrapper notification payloads."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from weaveflow.adapters.wrapper_notifications import (  # noqa: E402
    create_session_loss_notification,
    is_retry_safe_after_session_loss,
    wrapper_notification_to_payload,
    wrapper_notification_to_text,
)


def print_notification(label: str, action: str) -> None:
    notification = create_session_loss_notification(
        request_id=f"{label}-request",
        bridge_request_id=f"{label}-bridge",
        action=action,
        retry_safe=is_retry_safe_after_session_loss(action),
        metadata={"demo": True},
    )
    payload = wrapper_notification_to_payload(notification)

    print(f"{label} retry_safe: {notification.retry_safe}")
    print(f"{label} chat: {wrapper_notification_to_text(notification, style='chat')}")
    print(f"{label} log: {wrapper_notification_to_text(notification, style='log')}")
    print(
        f"{label} payload: "
        + json.dumps(
            {
                "notification_type": payload["notification_type"],
                "level": payload["level"],
                "retry_safe": payload["retry_safe"],
                "requires_user_repetition": payload["requires_user_repetition"],
            },
            sort_keys=True,
        )
    )


def main() -> None:
    print_notification("status", "status")
    print_notification("create_task", "create_task")
    print_notification("verify_task", "verify_task")


if __name__ == "__main__":
    main()
