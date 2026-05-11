"""Demonstrate compact wrapper result rendering."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from weaveflow.adapters.local_wrapper import LocalBridgeWrapper
from weaveflow.adapters.wrapper_rendering import (
    render_wrapper_result_as_text,
    render_wrapper_result_summary,
)


def payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def print_rendered(label: str, result, channel: str = "openclaw") -> None:
    rendered = render_wrapper_result_as_text(result, channel=channel)
    print(f"{label} -> {rendered}")


def main() -> None:
    with TemporaryDirectory() as root:
        wrapper = LocalBridgeWrapper(Path(root))
        health = wrapper.start()
        print(f"health -> ok={health.ok} pong={health.pong}")
        try:
            status = wrapper.handle_payload(payload("status", "m-status"))
            print_rendered("status", status)

            wrapper.handle_payload(payload("init workspace", "m-init"))
            wrapper.handle_payload(payload("yes", "m-init-yes"))

            create = wrapper.handle_payload(
                payload("create task Wrapper rendering demo task", "m-create")
            )
            print_rendered("create task", create)

            yes = wrapper.handle_payload(payload("yes", "m-create-yes"))
            print_rendered("yes confirmation", yes)

            explicit = wrapper.handle_payload(
                payload("verify TASK-0001 passed manual check", "m-verify"),
                bridge_request_id="b-verify",
            )
            print_rendered("explicit", explicit)

            mismatch = wrapper.handle_explicit_confirmation(
                "yes",
                bridge_request_id="b-verify",
            )
            print_rendered("mismatch", mismatch)

            high_risk = wrapper.handle_payload(
                payload("auto run codex", "m-risk"),
                bridge_request_id="b-risk",
            )
            print_rendered("auto_run_codex", high_risk)

            bad_payload = wrapper.handle_payload({"content": "status"})
            print_rendered("bad payload", bad_payload)

            print(f"log -> {render_wrapper_result_summary(mismatch)}")
        finally:
            wrapper.shutdown()


if __name__ == "__main__":
    main()
