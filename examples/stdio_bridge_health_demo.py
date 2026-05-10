"""Demo lightweight health checks for the ProjectOps stdio bridge."""

from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from projectops.adapters.stdio_health import check_bridge_subprocess_health  # noqa: E402


def print_result(label: str, root: Path, diagnostics: bool) -> None:
    result = check_bridge_subprocess_health(root, diagnostics=diagnostics)
    print(
        f"{label}: ok={result.ok} pong={result.pong} "
        f"stdout_valid={result.stdout_valid} stderr_valid={result.stderr_valid} "
        f"summary={result.summary}"
    )


def main() -> None:
    with TemporaryDirectory() as directory:
        root = Path(directory)
        print_result("without diagnostics", root, diagnostics=False)
        print_result("with diagnostics", root, diagnostics=True)


if __name__ == "__main__":
    main()
