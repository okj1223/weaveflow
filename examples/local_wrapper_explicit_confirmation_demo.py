"""Demo LocalBridgeWrapper explicit confirmation for sensitive actions."""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters.local_wrapper import (  # noqa: E402
    LocalBridgeWrapper,
    WrapperRouteResult,
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


def print_result(label: str, result: WrapperRouteResult) -> None:
    print(
        f"{label}: routed={result.routed} blocked={result.blocked} "
        f"route_reason={result.route_reason} action={result.action} "
        f"category={result.category} ok={result.ok} summary={result.summary}"
    )


def main() -> None:
    with TemporaryDirectory() as tempdir:
        wrapper = LocalBridgeWrapper(Path(tempdir))
        health = wrapper.start()
        print(f"health: ok={health.ok} pong={health.pong}")

        init = wrapper.handle_payload(payload("init workspace", "m-init"))
        print_result("init workspace", init)
        print_result("yes init", wrapper.handle_payload(payload("yes", "m-init-yes")))

        create = wrapper.handle_payload(
            payload("create task Explicit confirmation smoke task", "m-create")
        )
        print_result("create task", create)
        print_result("yes create", wrapper.handle_payload(payload("yes", "m-create-yes")))

        verify = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="bridge-verify",
        )
        print_result("verify_task explicit_confirmation_required", verify)

        phrase = str(verify.metadata.get("confirmation_phrase", ""))
        print(f"confirmation phrase: {phrase}")

        wrong = wrapper.handle_explicit_confirmation(
            "yes",
            bridge_request_id="bridge-verify",
        )
        print_result("yes mismatch", wrong)

        matched = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="bridge-verify",
        )
        print_result("exact phrase routed", matched)

        print_result("doctor", wrapper.handle_payload(payload("doctor", "m-doctor")))

        shutdown = wrapper.shutdown()
        if shutdown is not None:
            print_result("shutdown", shutdown)


if __name__ == "__main__":
    main()
