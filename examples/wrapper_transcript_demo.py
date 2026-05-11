"""Demonstrate local wrapper transcript review artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from weaveflow.adapters.local_wrapper import LocalBridgeWrapper
from weaveflow.adapters.wrapper_transcript import (
    run_payloads_with_transcript,
    transcript_to_json,
    transcript_to_markdown,
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


def main() -> None:
    with TemporaryDirectory() as root:
        wrapper = LocalBridgeWrapper(Path(root))
        health = wrapper.start()
        print(f"health -> ok={health.ok} pong={health.pong}")
        try:
            transcript = run_payloads_with_transcript(
                wrapper,
                [
                    payload("status", "m-status"),
                    payload("init workspace", "m-init"),
                    payload("yes", "m-init-yes"),
                    payload("create task Wrapper transcript demo task", "m-create"),
                    payload("yes", "m-create-yes"),
                    payload("list tasks", "m-list"),
                    payload("verify TASK-0001 passed manual check", "m-verify"),
                    payload("yes", "m-verify-yes"),
                    payload("auto run codex", "m-risk"),
                    {"content": "bad payload"},
                ],
                channel="openclaw",
            )

            transcript_json = json.loads(transcript_to_json(transcript))
            actions = [
                entry.get("action") or entry.get("label")
                for entry in transcript_json["entries"]
            ]
            print(
                "JSON transcript summary -> "
                f"transcript={transcript_json['transcript_id']} "
                f"entries={len(transcript_json['entries'])} "
                f"actions={actions}"
            )

            markdown = transcript_to_markdown(transcript)
            preview = "\n".join(markdown.splitlines()[:35])
            print("Markdown transcript preview:")
            print(preview)
        finally:
            wrapper.shutdown()


if __name__ == "__main__":
    main()
