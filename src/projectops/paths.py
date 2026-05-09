"""Path helpers for the local ProjectOps workspace."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


WORKSPACE_NAME = ".projectops"


@dataclass(frozen=True)
class WorkspacePaths:
    base_dir: Path

    @property
    def root(self) -> Path:
        return self.base_dir / WORKSPACE_NAME

    @property
    def config_path(self) -> Path:
        return self.root / "config.yaml"

    @property
    def state_path(self) -> Path:
        return self.root / "state.sqlite"

    @property
    def memory_dir(self) -> Path:
        return self.root / "memory"

    @property
    def project_memory_path(self) -> Path:
        return self.memory_dir / "project.md"

    @property
    def preferences_path(self) -> Path:
        return self.memory_dir / "preferences.yaml"

    @property
    def decisions_dir(self) -> Path:
        return self.memory_dir / "decisions"

    @property
    def tasks_dir(self) -> Path:
        return self.root / "tasks"

    def task_dir(self, task_id: str) -> Path:
        return self.tasks_dir / task_id

    def exists(self) -> bool:
        return self.root.exists()


def workspace_paths(base_dir: Path | None = None) -> WorkspacePaths:
    return WorkspacePaths(base_dir=(base_dir or Path.cwd()).resolve())


def ensure_workspace_dirs(paths: WorkspacePaths) -> None:
    paths.root.mkdir(exist_ok=True)
    paths.memory_dir.mkdir(exist_ok=True)
    paths.decisions_dir.mkdir(exist_ok=True)
    paths.tasks_dir.mkdir(exist_ok=True)
