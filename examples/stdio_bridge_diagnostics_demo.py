"""Demo structured diagnostics for the ProjectOps stdio bridge."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters.diagnostics import DiagnosticWriter  # noqa: E402
from projectops.adapters.stdio_bridge import run_stdio_bridge  # noqa: E402
from projectops.json_io import CONTRACT_VERSION  # noqa: E402


def bridge_request(
    bridge_request_id: str,
    request_type: str,
    payload: dict[str, Any] | None = None,
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
        "createdAt": "2026-05-10T00:00:00Z",
        "threadId": "thread-1",
    }


def describe_response(line: str) -> str:
    parsed = json.loads(line)
    response = parsed.get("response") or {}
    event_type = response.get("event_type")
    if event_type:
        return f"{parsed['bridge_request_id']} {parsed['type']} ok={parsed['ok']} event={event_type}"
    return f"{parsed['bridge_request_id']} {parsed['type']} ok={parsed['ok']}"


def describe_diagnostic(line: str) -> str:
    parsed = json.loads(line)
    return f"{parsed['level']} {parsed['event']} bridge_request_id={parsed.get('bridge_request_id')}"


def main() -> None:
    with TemporaryDirectory() as directory:
        requests = [
            bridge_request("ping", "ping"),
            bridge_request("status", "handle_payload", channel_payload("status", "m1")),
            "{not json",
            bridge_request("shutdown", "shutdown"),
        ]
        input_stream = io.StringIO("\n".join(requests) + "\n")
        output_stream = io.StringIO()
        diagnostics_stream = io.StringIO()
        writer = DiagnosticWriter(diagnostics_stream)

        run_stdio_bridge(
            Path(directory),
            input_stream,
            output_stream,
            diagnostic_writer=writer,
        )

        print("stdout responses:")
        for line in output_stream.getvalue().splitlines():
            print(describe_response(line))

        print("diagnostics:")
        for line in diagnostics_stream.getvalue().splitlines():
            print(describe_diagnostic(line))


if __name__ == "__main__":
    main()
