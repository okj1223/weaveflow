"""Demonstrate wrapper notifications for stale explicit confirmations."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from weaveflow.adapters.local_wrapper import LocalBridgeWrapper


def payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def notification_summary(result) -> str:
    notification = result.metadata.get("notification")
    if not isinstance(notification, dict):
        return "notification_type=None suggested_action=None"
    return (
        f"notification_type={notification.get('notification_type')} "
        f"suggested_action={notification.get('suggested_action')}"
    )


def print_result(label: str, result) -> None:
    print(
        f"{label} -> error_type={result.error_type} "
        f"routed={result.routed} {notification_summary(result)}"
    )


def main() -> None:
    with TemporaryDirectory() as root:
        wrapper = LocalBridgeWrapper(Path(root))
        health = wrapper.start()
        print(f"health -> ok={health.ok} pong={health.pong}")
        try:
            wrapper.handle_payload(payload("init workspace", "m-init"))
            wrapper.handle_payload(payload("yes", "m-init-yes"))
            wrapper.handle_payload(
                payload("create task Stale notification demo task", "m-create")
            )
            wrapper.handle_payload(payload("yes", "m-create-yes"))

            pending = wrapper.handle_payload(
                payload("verify TASK-0001 passed manual check", "m-verify"),
                bridge_request_id="b-verify",
            )
            phrase = pending.metadata.get("confirmation_phrase", "")
            print(f"pending -> phrase={phrase}")

            mismatch = wrapper.handle_explicit_confirmation(
                "yes",
                bridge_request_id="b-verify",
            )
            print_result("mismatch", mismatch)

            exact = wrapper.handle_explicit_confirmation(
                phrase,
                bridge_request_id="b-verify",
            )
            print_result("exact", exact)

            replay = wrapper.handle_explicit_confirmation(
                phrase,
                bridge_request_id="b-verify",
            )
            print_result("replay", replay)

            missing = wrapper.handle_explicit_confirmation(
                "confirm verify_task missing",
                request_id="missing",
            )
            print_result("missing", missing)
        finally:
            shutdown = wrapper.shutdown()
            if shutdown is not None:
                print(f"shutdown -> ok={shutdown.ok} error_type={shutdown.error_type}")


if __name__ == "__main__":
    main()
