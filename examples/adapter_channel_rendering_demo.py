"""Local channel rendering policy demo.

Run with:

    python3 examples/adapter_channel_rendering_demo.py

The demo uses a temporary workspace and does not modify the repository's real
.projectops directory.
"""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from projectops.adapters import (  # noqa: E402
    AdapterSession,
    AdapterTranscript,
    ProjectOpsServiceAdapter,
    event_from_turn_result,
    render_event_for_channel,
    render_transcript_for_channel,
)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        session = AdapterSession(ProjectOpsServiceAdapter(root))

        turns = [
            session.handle_text("status", request_id="demo-status"),
            session.handle_text("init workspace", request_id="demo-reject"),
            session.reject("demo-reject"),
            session.handle_text(
                "init workspace",
                request_id="demo-init",
                allow_mutation=True,
            ),
            session.handle_text("unknown command", request_id="demo-error"),
        ]
        events = [event_from_turn_result(turn) for turn in turns]
        transcript = AdapterTranscript(session_id="demo-channel-rendering", events=events)

        for channel in ["openclaw", "telegram", "log"]:
            print(f"== {channel} ==")
            for event in events:
                print(render_event_for_channel(event, channel=channel))
            print()

        print("== transcript log ==")
        print(render_transcript_for_channel(transcript, channel="log"))


if __name__ == "__main__":
    main()
