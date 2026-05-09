"""Local ProjectOps adapter renderer demo.

Run with:

    python3 examples/adapter_renderer_demo.py

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
    render_event_as_text,
    render_transcript_as_text,
)


def main() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        session = AdapterSession(ProjectOpsServiceAdapter(root))
        transcript = AdapterTranscript(session_id="renderer-demo")

        def record(turn) -> None:
            event = event_from_turn_result(turn)
            transcript.add_event(event)
            print(render_event_as_text(event, style="chat"))
            print("---")

        record(session.handle_text("status", request_id="demo-status"))

        record(session.handle_text("init workspace", request_id="demo-reject"))
        record(session.reject("demo-reject"))

        record(session.handle_text("init workspace", request_id="demo-init"))
        record(session.confirm("demo-init"))

        record(session.handle_text("create task Renderer demo task", request_id="demo-task"))
        record(session.confirm("demo-task"))

        record(session.handle_text("doctor", request_id="demo-doctor"))
        record(session.handle_text("unknown nonsense", request_id="demo-error"))

        print("Transcript log view")
        print(render_transcript_as_text(transcript, style="log"))


if __name__ == "__main__":
    main()
