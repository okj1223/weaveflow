"""Subprocess client demo for the Weaveflow stdio bridge."""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from weaveflow.adapters.stdio_client import StdioBridgeClient  # noqa: E402
from weaveflow.json_io import CONTRACT_VERSION  # noqa: E402


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "bridge_request_id": bridge_request_id,
        "type": request_type,
        "payload": payload or {},
    }


def channel_payload(text: str, message_id: str) -> dict[str, str]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def describe(response: dict[str, Any]) -> str:
    nested = response.get("response") or {}
    event_type = nested.get("event_type")
    requires_confirmation = nested.get("requires_confirmation")
    parts = [
        str(response.get("bridge_request_id")),
        f"ok={response.get('ok')}",
        f"type={response.get('type')}",
    ]
    if event_type is not None:
        parts.append(f"event={event_type}")
    if requires_confirmation is not None:
        parts.append(f"requires_confirmation={requires_confirmation}")
    return " ".join(parts)


def main() -> None:
    with TemporaryDirectory() as directory:
        command = [
            sys.executable,
            "-m",
            "weaveflow.adapters.stdio_bridge",
            "--root",
            directory,
        ]
        client = StdioBridgeClient(command)
        client.start()
        try:
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
                    channel_payload("create task Stdio bridge client demo", "m4"),
                ),
                bridge_request("create-yes", "handle_payload", channel_payload("yes", "m5")),
                bridge_request("list", "handle_payload", channel_payload("list tasks", "m6")),
                bridge_request("doctor", "handle_payload", channel_payload("doctor", "m7")),
                bridge_request("shutdown", "shutdown"),
            ]

            for request in requests:
                print(describe(client.send(request)))
        finally:
            client.close()


if __name__ == "__main__":
    main()
