"""Demo subprocess stdout/stderr capture for stdio bridge diagnostics."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from weaveflow.json_io import CONTRACT_VERSION  # noqa: E402


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


def parse_json_lines(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    parsed: list[dict[str, Any]] = []
    errors: list[str] = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(str(exc))
            continue
        if isinstance(item, dict):
            parsed.append(item)
        else:
            errors.append("line did not parse to a JSON object")
    return parsed, errors


def main() -> int:
    with TemporaryDirectory() as directory:
        requests = [
            bridge_request("ping", "ping"),
            bridge_request("status", "handle_payload", channel_payload("status", "m1")),
            bridge_request(
                "init",
                "handle_payload",
                channel_payload("init workspace", "m2"),
            ),
            bridge_request("yes", "handle_payload", channel_payload("yes", "m3")),
            "{not json",
            bridge_request("shutdown", "shutdown"),
        ]
        command = [
            sys.executable,
            "-m",
            "weaveflow.adapters.stdio_bridge",
            "--root",
            directory,
            "--diagnostics-stderr",
        ]
        result = subprocess.run(
            command,
            input="\n".join(requests) + "\n",
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )

    stdout_json, stdout_errors = parse_json_lines(result.stdout)
    stderr_json, stderr_errors = parse_json_lines(result.stderr)
    response_types = [item.get("type") for item in stdout_json]
    diagnostic_events = [item.get("event") for item in stderr_json]

    print(f"stdout response count: {len(stdout_json)}")
    print(f"stderr diagnostic count: {len(stderr_json)}")
    print(f"stdout response types: {', '.join(str(item) for item in response_types)}")
    print(
        "stderr diagnostic events: "
        + ", ".join(str(item) for item in diagnostic_events)
    )
    print(f"stdout_json_only: {not stdout_errors}")
    print(f"stderr_json_only: {not stderr_errors}")

    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
