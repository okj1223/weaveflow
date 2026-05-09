"""Service boundary for ProjectOps workflow operations.

Future adapters such as OpenClaw, Slack, Telegram, or a web UI should call this
module instead of Typer command functions.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict
from pathlib import Path
from typing import Any

from projectops.errors import MissingResultFileError, WorkspaceNotFoundError
from projectops.models import (
    Artifact,
    DoctorCheck,
    DoctorReport,
    Plan,
    ProjectConfig,
    TaskListItem,
    TaskSpec,
    TaskStatus,
    VerificationRecord,
)
from projectops.paths import WorkspacePaths, ensure_workspace_dirs, workspace_paths
from projectops.store import TaskRepository, initialize_state
from projectops.yaml_io import read_yaml, write_yaml


def init_workspace(root: Path) -> ProjectConfig:
    paths = workspace_paths(root)
    ensure_workspace_dirs(paths)

    if paths.config_path.exists():
        config = ProjectConfig.model_validate(read_yaml(paths.config_path))
    else:
        config = ProjectConfig()
    write_yaml(paths.config_path, config)

    if not paths.project_memory_path.exists():
        paths.project_memory_path.write_text("# Project Memory\n", encoding="utf-8")
    if not paths.preferences_path.exists():
        write_yaml(paths.preferences_path, {"preferences": []})

    initialize_state(paths.state_path)
    return config


def get_status(root: Path) -> dict[str, Any]:
    paths = workspace_paths(root)
    exists = paths.exists()
    tasks = [asdict(task) for task in TaskRepository(paths).list_tasks()] if exists else []
    return {
        "workspace_exists": exists,
        "task_count": len(tasks) if exists else 0,
        "state_path": paths.state_path,
        "memory_dir": paths.memory_dir,
        "workspace_path": paths.root,
        "tasks": tasks,
    }


def create_task(root: Path, user_request: str) -> TaskSpec:
    paths = require_workspace(root)
    return TaskRepository(paths).create_task(user_request).spec


def show_task(root: Path, task_id: str) -> TaskSpec:
    paths = require_workspace(root)
    spec, _task_dir = TaskRepository(paths).load_task_spec(task_id)
    return spec


def create_plan(root: Path, task_id: str) -> Plan:
    paths = require_workspace(root)
    return TaskRepository(paths).create_plan(task_id).plan


def create_worker_brief(root: Path, task_id: str, worker: str = "codex") -> Path:
    paths = require_workspace(root)
    return TaskRepository(paths).create_worker_brief(task_id, worker).path


def attach_result(root: Path, task_id: str, result_path: Path) -> Artifact:
    paths = require_workspace(root)
    source_path = resolve_input_path(root, result_path)
    if not source_path.is_file():
        raise MissingResultFileError(f"Result file not found: {result_path}")
    return TaskRepository(paths).attach_result(task_id, source_path).artifact


def verify_task(
    root: Path, task_id: str, status: str, note: str
) -> VerificationRecord:
    paths = require_workspace(root)
    return TaskRepository(paths).record_verification(task_id, status, note).record


def create_final_report(root: Path, task_id: str) -> Path:
    paths = require_workspace(root)
    return TaskRepository(paths).generate_final_report(task_id).path


def propose_memory_update(root: Path, task_id: str) -> Path:
    paths = require_workspace(root)
    return TaskRepository(paths).propose_memory_diff(task_id).path


def list_tasks(root: Path) -> list[TaskListItem]:
    paths = require_workspace(root)
    return [
        TaskListItem(
            id=task.id,
            title=task.title,
            status=task.status,
            created_at=task.created_at,
            updated_at=task.updated_at,
        )
        for task in TaskRepository(paths).list_tasks()
    ]


def doctor_workspace(root: Path) -> DoctorReport:
    root = root.resolve()
    paths = workspace_paths(root)
    checks: list[DoctorCheck] = []

    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        path_text = display_path(root, path) if path else None
        checks.append(
            DoctorCheck(name=name, level=level, message=message, path=path_text)
        )

    if not paths.root.exists():
        add(
            "error",
            "workspace_exists",
            f"workspace missing: {display_path(root, paths.root)}. Run `ops init` first.",
            paths.root,
        )
        return DoctorReport.from_checks(checks)

    add("ok", "workspace_exists", f"workspace exists: {display_path(root, paths.root)}", paths.root)

    required_paths = [
        ("config_exists", paths.config_path, "config exists", "file"),
        ("state_database_exists", paths.state_path, "state database exists", "file"),
        ("memory_dir_exists", paths.memory_dir, "memory directory exists", "dir"),
        ("project_memory_exists", paths.project_memory_path, "project memory exists", "file"),
        ("preferences_exists", paths.preferences_path, "preferences exist", "file"),
        ("decisions_dir_exists", paths.decisions_dir, "decisions directory exists", "dir"),
        ("tasks_dir_exists", paths.tasks_dir, "tasks directory exists", "dir"),
    ]
    for name, path, label, expected_type in required_paths:
        if expected_type == "dir":
            exists = path.is_dir()
        else:
            exists = path.is_file()
        if exists:
            add("ok", name, f"{label}: {display_path(root, path)}", path)
        else:
            add("error", name, f"{label} missing: {display_path(root, path)}", path)

    task_rows: list[dict[str, str]] = []
    sqlite_healthy = False
    if paths.state_path.is_file():
        task_rows, sqlite_healthy = inspect_task_rows(root, paths.state_path, checks)

    indexed_task_ids = {row["id"] for row in task_rows} if sqlite_healthy else set()
    if paths.tasks_dir.is_dir():
        for task_dir in sorted(paths.tasks_dir.glob("TASK-*")):
            if not task_dir.is_dir():
                continue
            if task_dir.name in indexed_task_ids:
                add(
                    "ok",
                    f"{task_dir.name}_indexed",
                    f"{task_dir.name} indexed in SQLite",
                    task_dir,
                )
            elif sqlite_healthy:
                add(
                    "error",
                    f"{task_dir.name}_indexed",
                    f"{task_dir.name} task directory is not indexed in SQLite",
                    task_dir,
                )

    for row in task_rows:
        inspect_task_row(root, row, checks)

    return DoctorReport.from_checks(checks)


def require_workspace(root: Path) -> WorkspacePaths:
    paths = workspace_paths(root)
    if not paths.exists():
        raise WorkspaceNotFoundError(
            "ProjectOps workspace not found. Run `ops init` first."
        )
    return paths


def resolve_input_path(root: Path, path: Path) -> Path:
    if path.is_absolute():
        return path
    return root.resolve() / path


def display_path(root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path)


def inspect_task_rows(
    root: Path, state_path: Path, checks: list[DoctorCheck]
) -> tuple[list[dict[str, str]], bool]:
    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        checks.append(
            DoctorCheck(
                name=name,
                level=level,
                message=message,
                path=display_path(root, path) if path else None,
            )
        )

    expected_columns = {"id", "title", "status", "created_at", "updated_at", "task_dir"}
    try:
        db_uri = f"{state_path.resolve().as_uri()}?mode=ro"
        with sqlite3.connect(db_uri, uri=True) as connection:
            connection.row_factory = sqlite3.Row
            add(
                "ok",
                "state_database_open",
                f"state database opens read-only: {display_path(root, state_path)}",
                state_path,
            )
            table = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
            ).fetchone()
            if table is None:
                add("error", "tasks_table_exists", "SQLite tasks table missing", state_path)
                return [], False

            add("ok", "tasks_table_exists", "SQLite tasks table exists", state_path)
            columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(tasks)").fetchall()
            }
            missing_columns = sorted(expected_columns - columns)
            if missing_columns:
                add(
                    "error",
                    "tasks_table_columns",
                    f"SQLite tasks table missing columns: {', '.join(missing_columns)}",
                    state_path,
                )
                return [], False

            add(
                "ok",
                "tasks_table_columns",
                "SQLite tasks table has expected columns",
                state_path,
            )
            rows = connection.execute(
                """
                SELECT id, title, status, created_at, updated_at, task_dir
                FROM tasks
                ORDER BY created_at ASC
                """
            ).fetchall()
    except sqlite3.Error as error:
        add(
            "error",
            "state_database_open",
            f"state database cannot be opened read-only: {error}",
            state_path,
        )
        return [], False

    return [
        {
            "id": str(row["id"]),
            "title": str(row["title"]),
            "status": str(row["status"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
            "task_dir": str(row["task_dir"]),
        }
        for row in rows
    ], True


def inspect_task_row(root: Path, row: dict[str, str], checks: list[DoctorCheck]) -> None:
    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        checks.append(
            DoctorCheck(
                name=name,
                level=level,
                message=message,
                path=display_path(root, path) if path else None,
            )
        )

    task_id = row["id"]
    sqlite_status = row["status"]
    task_dir = Path(row["task_dir"])
    if not task_dir.is_absolute():
        task_dir = root / task_dir

    if not is_known_task_status(sqlite_status):
        add(
            "error",
            f"{task_id}_sqlite_status",
            f"{task_id} SQLite status is invalid: {sqlite_status}",
            task_dir,
        )

    if not task_dir.is_dir():
        add(
            "error",
            f"{task_id}_task_dir_exists",
            f"{task_id} task directory missing: {display_path(root, task_dir)}",
            task_dir,
        )
        return
    add("ok", f"{task_id}_task_dir_exists", f"{task_id} task directory exists", task_dir)

    spec_path = task_dir / "task_spec.yaml"
    artifacts_dir = task_dir / "artifacts"
    if spec_path.is_file():
        add("ok", f"{task_id}_task_spec_exists", f"{task_id} task_spec.yaml exists", spec_path)
    else:
        add(
            "error",
            f"{task_id}_task_spec_exists",
            f"{task_id} task_spec.yaml missing",
            spec_path,
        )

    if artifacts_dir.is_dir():
        add("ok", f"{task_id}_artifacts_dir_exists", f"{task_id} artifacts/ exists", artifacts_dir)
    else:
        add(
            "error",
            f"{task_id}_artifacts_dir_exists",
            f"{task_id} artifacts/ missing",
            artifacts_dir,
        )

    spec_status = load_task_spec_status(root, task_id, spec_path, checks)
    if spec_status is not None:
        if spec_status == sqlite_status:
            add(
                "ok",
                f"{task_id}_status_match",
                f"{task_id} SQLite status matches task_spec.yaml",
                spec_path,
            )
        else:
            add(
                "error",
                f"{task_id}_status_match",
                (
                    f"{task_id} SQLite status ({sqlite_status}) does not match "
                    f"task_spec.yaml status ({spec_status})"
                ),
                spec_path,
            )

    effective_status = sqlite_status if is_known_task_status(sqlite_status) else spec_status
    if effective_status and is_known_task_status(effective_status):
        inspect_required_task_files(root, task_id, task_dir, effective_status, checks)

    artifacts_path = task_dir / "artifacts.yaml"
    if artifacts_path.exists():
        inspect_artifacts_yaml(root, task_id, task_dir, artifacts_path, checks)


def load_task_spec_status(
    root: Path, task_id: str, spec_path: Path, checks: list[DoctorCheck]
) -> str | None:
    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        checks.append(
            DoctorCheck(
                name=name,
                level=level,
                message=message,
                path=display_path(root, path) if path else None,
            )
        )

    if not spec_path.is_file():
        return None

    try:
        data = read_yaml(spec_path)
    except Exception as error:
        add(
            "error",
            f"{task_id}_task_spec_parse",
            f"{task_id} task_spec.yaml cannot be parsed: {error}",
            spec_path,
        )
        return None

    raw_status = data.get("status")
    if raw_status is None:
        add(
            "error",
            f"{task_id}_task_spec_status",
            f"{task_id} task_spec.yaml status missing",
            spec_path,
        )
        return None

    status = str(raw_status)
    if is_known_task_status(status):
        add(
            "ok",
            f"{task_id}_task_spec_status",
            f"{task_id} task_spec.yaml status is valid: {status}",
            spec_path,
        )
    else:
        add(
            "error",
            f"{task_id}_task_spec_status",
            f"{task_id} task_spec.yaml status is invalid: {status}",
            spec_path,
        )
    return status


def inspect_required_task_files(
    root: Path,
    task_id: str,
    task_dir: Path,
    status: str,
    checks: list[DoctorCheck],
) -> None:
    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        checks.append(
            DoctorCheck(
                name=name,
                level=level,
                message=message,
                path=display_path(root, path) if path else None,
            )
        )

    required_files_by_status = {
        TaskStatus.DRAFT.value: [],
        TaskStatus.PLANNED.value: ["plan.yaml"],
        TaskStatus.BRIEFED.value: ["plan.yaml", "worker_brief_codex.md"],
        TaskStatus.RESULT_ATTACHED.value: ["artifacts.yaml"],
        TaskStatus.VERIFYING.value: ["artifacts.yaml"],
        TaskStatus.VERIFIED.value: ["artifacts.yaml", "verification_record.yaml"],
        TaskStatus.FAILED.value: ["verification_record.yaml"],
        TaskStatus.BLOCKED.value: ["verification_record.yaml"],
        TaskStatus.COMPLETED.value: [
            "artifacts.yaml",
            "verification_record.yaml",
            "final_report.md",
        ],
    }

    for filename in required_files_by_status[status]:
        path = task_dir / filename
        if path.is_file():
            add("ok", f"{task_id}_{filename}_exists", f"{task_id} {filename} exists", path)
        else:
            add(
                "error",
                f"{task_id}_{filename}_exists",
                f"{task_id} {filename} missing for status {status}",
                path,
            )

    if status == TaskStatus.COMPLETED.value:
        memory_diff_path = task_dir / "memory_diff.md"
        if memory_diff_path.is_file():
            add(
                "ok",
                f"{task_id}_memory_diff_exists",
                f"{task_id} memory_diff.md exists",
                memory_diff_path,
            )
        else:
            add(
                "warn",
                f"{task_id}_memory_diff_exists",
                f"{task_id} memory_diff.md not found after completed task",
                memory_diff_path,
            )


def inspect_artifacts_yaml(
    root: Path,
    task_id: str,
    task_dir: Path,
    artifacts_path: Path,
    checks: list[DoctorCheck],
) -> None:
    def add(level: str, name: str, message: str, path: Path | None = None) -> None:
        checks.append(
            DoctorCheck(
                name=name,
                level=level,
                message=message,
                path=display_path(root, path) if path else None,
            )
        )

    try:
        data = read_yaml(artifacts_path)
    except Exception as error:
        add(
            "error",
            f"{task_id}_artifacts_yaml_parse",
            f"{task_id} artifacts.yaml cannot be parsed: {error}",
            artifacts_path,
        )
        return

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        add(
            "error",
            f"{task_id}_artifacts_yaml_format",
            f"{task_id} artifacts.yaml must contain an artifacts list",
            artifacts_path,
        )
        return

    add("ok", f"{task_id}_artifacts_yaml_format", f"{task_id} artifacts.yaml is readable", artifacts_path)
    for index, artifact in enumerate(artifacts, start=1):
        if not isinstance(artifact, dict):
            add(
                "error",
                f"{task_id}_artifact_{index}_format",
                f"{task_id} artifact entry {index} is not a mapping",
                artifacts_path,
            )
            continue

        raw_path = artifact.get("path")
        if not raw_path:
            add(
                "error",
                f"{task_id}_artifact_{index}_path",
                f"{task_id} artifact entry {index} path missing",
                artifacts_path,
            )
            continue

        artifact_path = Path(str(raw_path))
        if not artifact_path.is_absolute():
            artifact_path = task_dir / artifact_path
        if artifact_path.is_file():
            add(
                "ok",
                f"{task_id}_artifact_{index}_exists",
                f"{task_id} artifact exists: {display_path(root, artifact_path)}",
                artifact_path,
            )
        else:
            add(
                "error",
                f"{task_id}_artifact_{index}_exists",
                f"{task_id} artifact file missing: {raw_path}",
                artifact_path,
            )


def is_known_task_status(status: str) -> bool:
    return status in {item.value for item in TaskStatus}
