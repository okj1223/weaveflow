"""Demo the local wrapper smoke flow around the stdio bridge."""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from weaveflow.adapters.local_wrapper import (  # noqa: E402
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
        print(f"health: ok={health.ok} pong={health.pong} summary={health.summary}")

        print_result("status", wrapper.handle_payload(payload("status", "m-status")))

        # Create a workspace in the temporary root so the task flow can complete.
        print_result(
            "init workspace",
            wrapper.handle_payload(payload("init workspace", "m-init")),
        )
        print_result("yes init", wrapper.handle_payload(payload("yes", "m-init-yes")))

        print_result(
            "create task",
            wrapper.handle_payload(
                payload("create task Local wrapper smoke task", "m-create")
            ),
        )
        print_result("yes", wrapper.handle_payload(payload("yes", "m-create-yes")))
        print_result(
            "list tasks",
            wrapper.handle_payload(payload("list tasks", "m-list")),
        )
        print_result(
            "verify",
            wrapper.handle_payload(
                payload("verify TASK-0001 passed manual check", "m-verify")
            ),
        )
        print_result(
            "auto run codex",
            wrapper.handle_payload(payload("auto run codex", "m-codex")),
        )
        print_result(
            "bad payload",
            wrapper.handle_payload({"messageId": "bad-1"}),
        )
        shutdown = wrapper.shutdown()
        if shutdown is not None:
            print_result("shutdown", shutdown)


if __name__ == "__main__":
    main()
