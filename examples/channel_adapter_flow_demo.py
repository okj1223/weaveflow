"""Local channel adapter contract smoke demo.

This demo uses raw OpenClaw-like dictionaries and a temporary ProjectOps root.
It does not import real OpenClaw, call external APIs, or modify the repository
workspace.
"""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters import (  # noqa: E402
    AdapterSession,
    ProjectOpsServiceAdapter,
    event_from_turn_result,
    render_event_for_channel,
)
from projectops.adapters.openclaw import OpenClawAdapter  # noqa: E402


def payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-09T00:00:00Z",
        "threadId": "thread-1",
    }


def print_payload_result(label: str, result: dict[str, object]) -> None:
    if result.get("ok"):
        print(f"{label} -> ok=True event={result.get('event_type')}")
    else:
        print(
            f"{label} -> ok=False event={result.get('event_type')} "
            f"error={result.get('error_type')}"
        )


def one_line(text: str) -> str:
    return " ".join(text.split())


def main() -> None:
    with TemporaryDirectory() as directory:
        root = Path(directory)
        adapter = OpenClawAdapter(root)

        print_payload_result(
            "status payload",
            adapter.handle_payload(payload("status", "msg-status")),
        )
        print_payload_result(
            "init payload",
            adapter.handle_payload(payload("init workspace", "msg-init")),
        )
        print_payload_result(
            "yes payload",
            adapter.handle_payload(payload("yes", "msg-init-yes")),
        )
        print_payload_result(
            "create task payload",
            adapter.handle_payload(
                payload("create task Channel adapter smoke test", "msg-create")
            ),
        )
        print_payload_result(
            "yes payload",
            adapter.handle_payload(payload("yes", "msg-create-yes")),
        )
        print_payload_result(
            "list tasks payload",
            adapter.handle_payload(payload("list tasks", "msg-list")),
        )
        print_payload_result(
            "doctor payload",
            adapter.handle_payload(payload("doctor", "msg-doctor")),
        )
        print_payload_result(
            "bad payload",
            adapter.handle_payload({"messageId": "bad-1", "content": "status"}),
        )

        session = AdapterSession(ProjectOpsServiceAdapter(root))
        event = event_from_turn_result(
            session.handle_text("status", request_id="render-status")
        )
        print(
            "openclaw render -> "
            + one_line(render_event_for_channel(event, channel="openclaw"))
        )
        print("log render -> " + render_event_for_channel(event, channel="log"))


if __name__ == "__main__":
    main()
