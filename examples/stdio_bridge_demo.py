"""Local stdio bridge demo using in-memory streams and a temporary workspace."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters.stdio_bridge import run_stdio_bridge  # noqa: E402
from projectops.json_io import CONTRACT_VERSION  # noqa: E402


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, object] | None = None,
) -> str:
    return json.dumps(
        {
            "contract_version": CONTRACT_VERSION,
            "bridge_request_id": bridge_request_id,
            "type": request_type,
            "payload": payload or {},
        }
    )


def channel_payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-09T00:00:00Z",
        "threadId": "thread-1",
    }


def describe(line: str) -> str:
    parsed = json.loads(line)
    response = parsed.get("response") or {}
    event_type = response.get("event_type")
    error_type = parsed.get("error_type") or response.get("error_type")
    label = parsed["bridge_request_id"]
    request_type = parsed["type"]
    if error_type:
        return f"{label} {request_type} -> ok={parsed['ok']} error={error_type}"
    if event_type:
        return f"{label} {request_type} -> ok={parsed['ok']} event={event_type}"
    return f"{label} {request_type} -> ok={parsed['ok']} response={response}"


def main() -> None:
    with TemporaryDirectory() as directory:
        root = Path(directory)
        requests = [
            bridge_request("ping", "ping"),
            bridge_request("status", "handle_payload", channel_payload("status", "m1")),
            bridge_request(
                "init",
                "handle_payload",
                channel_payload("init workspace", "m2"),
            ),
            bridge_request("init-yes", "handle_payload", channel_payload("yes", "m3")),
            bridge_request(
                "create",
                "handle_payload",
                channel_payload("create task Stdio bridge demo", "m4"),
            ),
            bridge_request("create-yes", "handle_payload", channel_payload("yes", "m5")),
            bridge_request(
                "list",
                "handle_payload",
                channel_payload("list tasks", "m6"),
            ),
            bridge_request(
                "doctor",
                "handle_payload",
                channel_payload("doctor", "m7"),
            ),
            bridge_request("bad-request", "handle_payload", {"messageId": "bad-1"}),
            bridge_request("shutdown", "shutdown"),
        ]

        input_stream = io.StringIO("\n".join(requests) + "\n")
        output_stream = io.StringIO()
        exit_code = run_stdio_bridge(root, input_stream, output_stream)

        print(f"exit -> {exit_code}")
        for line in output_stream.getvalue().splitlines():
            print(describe(line))


if __name__ == "__main__":
    main()
