"""Demo LocalBridgeWrapper restart and session-loss behavior."""

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
        f"route_reason={result.route_reason} ok={result.ok} "
        f"error_type={result.error_type} summary={result.summary}"
    )


def start(root: Path) -> LocalBridgeWrapper:
    wrapper = LocalBridgeWrapper(root)
    health = wrapper.start()
    print(f"health: ok={health.ok} pong={health.pong}")
    return wrapper


def confirm_safe(wrapper: LocalBridgeWrapper, text: str, message_id: str) -> None:
    pending = wrapper.handle_payload(payload(text, message_id))
    print_result(f"pending {text}", pending)
    confirmed = wrapper.handle_payload(payload("yes", f"{message_id}-yes"))
    print_result(f"confirm {text}", confirmed)


def main() -> None:
    with TemporaryDirectory() as tempdir:
        root = Path(tempdir)

        wrapper = start(root)
        confirm_safe(wrapper, "init workspace", "m-init")
        confirm_safe(wrapper, "create task Durable restart task", "m-create-durable")
        durable_task = root / ".weaveflow" / "tasks" / "TASK-0001" / "task_spec.yaml"
        print(f"durable task before restart: exists={durable_task.exists()}")
        wrapper.shutdown()

        wrapper = start(root)
        print_result("list tasks after restart", wrapper.handle_payload(payload("list tasks", "m-list")))
        print(f"durable task after restart: exists={durable_task.exists()}")

        pending_create = wrapper.handle_payload(
            payload("create task Lost pending task", "m-create-lost")
        )
        print_result("pending create before restart", pending_create)
        wrapper.shutdown()

        wrapper = start(root)
        yes_after_restart = wrapper.handle_payload(payload("yes", "m-yes-after-restart"))
        print_result("yes after restart", yes_after_restart)
        lost_task = root / ".weaveflow" / "tasks" / "TASK-0002" / "task_spec.yaml"
        print(f"lost pending task after restart: exists={lost_task.exists()}")

        pending_explicit = wrapper.handle_payload(
            payload("verify TASK-0001 passed manual check", "m-verify"),
            bridge_request_id="b-verify",
        )
        print_result("pending explicit before restart", pending_explicit)
        phrase = str(pending_explicit.metadata.get("confirmation_phrase", ""))
        wrapper.shutdown()

        wrapper = start(root)
        exact_after_restart = wrapper.handle_explicit_confirmation(
            phrase,
            bridge_request_id="b-verify",
        )
        print_result("exact phrase after restart", exact_after_restart)
        verification = root / ".weaveflow" / "tasks" / "TASK-0001" / "verification_record.yaml"
        print(f"verification after restart: exists={verification.exists()}")
        print_result("doctor", wrapper.handle_payload(payload("doctor", "m-doctor")))
        print(wrapper.session_loss_message())
        wrapper.shutdown()


if __name__ == "__main__":
    main()
