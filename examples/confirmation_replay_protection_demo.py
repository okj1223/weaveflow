"""Demonstrate in-memory explicit confirmation replay protection."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from projectops.adapters.local_wrapper import LocalBridgeWrapper


def payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def print_result(label: str, result) -> None:
    print(
        f"{label} -> ok={result.ok} routed={result.routed} "
        f"blocked={result.blocked} reason={result.route_reason} "
        f"error_type={result.error_type}"
    )


def main() -> None:
    with TemporaryDirectory() as root:
        wrapper = LocalBridgeWrapper(Path(root))
        health = wrapper.start()
        print(f"health -> ok={health.ok} pong={health.pong}")
        try:
            init = wrapper.handle_payload(payload("init workspace", "m-init"))
            print_result("init pending", init)
            init_yes = wrapper.handle_payload(payload("yes", "m-init-yes"))
            print_result("init yes", init_yes)

            create = wrapper.handle_payload(
                payload("create task Replay protection demo task", "m-create")
            )
            print_result("create pending", create)
            create_yes = wrapper.handle_payload(payload("yes", "m-create-yes"))
            print_result("create yes", create_yes)

            pending = wrapper.handle_payload(
                payload("verify TASK-0001 passed manual check", "m-verify"),
                bridge_request_id="b-verify",
            )
            print_result("pending", pending)
            phrase = pending.metadata.get("confirmation_phrase", "")
            print(f"confirmation phrase -> {phrase}")

            mismatch = wrapper.handle_explicit_confirmation(
                "yes",
                bridge_request_id="b-verify",
            )
            print_result("mismatch", mismatch)

            first_exact = wrapper.handle_explicit_confirmation(
                phrase,
                bridge_request_id="b-verify",
            )
            print_result("first exact", first_exact)

            replay_exact = wrapper.handle_explicit_confirmation(
                phrase,
                bridge_request_id="b-verify",
            )
            print_result("replay exact", replay_exact)
        finally:
            shutdown = wrapper.shutdown()
            if shutdown is not None:
                print_result("shutdown", shutdown)


if __name__ == "__main__":
    main()
