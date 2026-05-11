"""Local Weaveflow adapter event model demo.

Run with:

    python3 examples/adapter_event_demo.py

The demo uses a temporary workspace and does not modify the repository's real
.weaveflow directory.
"""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from weaveflow.adapters import (  # noqa: E402
    AdapterSession,
    AdapterTranscript,
    WeaveflowServiceAdapter,
    event_from_turn_result,
    event_to_display_line,
)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        session = AdapterSession(WeaveflowServiceAdapter(root))
        transcript = AdapterTranscript(session_id="demo-session")

        def record(turn) -> None:
            event = event_from_turn_result(turn)
            transcript.add_event(event)
            print(event_to_display_line(event))

        record(session.handle_text("status", request_id="demo-status"))

        record(session.handle_text("init workspace", request_id="demo-reject"))
        record(session.reject("demo-reject"))

        record(session.handle_text("init workspace", request_id="demo-init"))
        record(session.confirm("demo-init"))

        record(session.handle_text("create task Event demo task", request_id="demo-task"))
        record(session.confirm("demo-task"))

        record(session.handle_text("doctor", request_id="demo-doctor"))
        record(session.handle_text("unknown nonsense", request_id="demo-error"))

        print(f"transcript event count: {len(transcript.events)}")


if __name__ == "__main__":
    main()
