"""Tiny local client for the Weaveflow stdio bridge."""

from __future__ import annotations

import json
import subprocess
from typing import Any, Optional

from weaveflow.json_io import CONTRACT_VERSION


class StdioBridgeClient:
    """Minimal subprocess wrapper for line-delimited bridge requests."""

    def __init__(self, command: list[str]) -> None:
        self.command = list(command)
        self._process: Optional[subprocess.Popen[str]] = None

    def start(self) -> None:
        if self.is_running():
            return

        self._process = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def send(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.is_running() or self._process is None:
            raise RuntimeError("Stdio bridge process is not running.")

        stdin = self._process.stdin
        stdout = self._process.stdout
        if stdin is None or stdout is None:
            raise RuntimeError("Stdio bridge process streams are unavailable.")

        stdin.write(json.dumps(request) + "\n")
        stdin.flush()

        line = stdout.readline()
        if not line:
            raise RuntimeError("Stdio bridge process closed without a response.")
        response = json.loads(line)
        if not isinstance(response, dict):
            raise RuntimeError("Stdio bridge response must be a JSON object.")
        return response

    def close(self) -> None:
        process = self._process
        if process is None:
            return

        if process.poll() is None:
            try:
                self.send(
                    {
                        "contract_version": CONTRACT_VERSION,
                        "bridge_request_id": "client-shutdown",
                        "type": "shutdown",
                        "payload": {},
                    }
                )
            except (BrokenPipeError, RuntimeError, ValueError, json.JSONDecodeError):
                pass

        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)

        self._process = None

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None
