"""SQLite state index for ProjectOps tasks."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from shutil import copy2

from projectops.errors import (
    InvalidTaskRequestError,
    InvalidVerificationStatusError,
    MissingPlanError,
    MissingResultFileError,
    TaskNotFoundError,
    UnsupportedWorkerError,
)
from projectops.models import (
    Artifact,
    MemoryDiff,
    Plan,
    PlanNode,
    TaskSpec,
    TaskStatus,
    VerificationCommand,
    VerificationRecord,
    utc_now_iso,
)
from projectops.paths import WorkspacePaths
from projectops.yaml_io import read_yaml, write_yaml


CREATE_TASKS_TABLE = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_dir TEXT NOT NULL
)
"""


@dataclass(frozen=True)
class CreatedTask:
    spec: TaskSpec
    task_dir: Path


@dataclass(frozen=True)
class TaskRow:
    id: str
    title: str
    status: str
    created_at: str
    updated_at: str
    task_dir: str


@dataclass(frozen=True)
class GeneratedPlan:
    plan: Plan
    path: Path


@dataclass(frozen=True)
class GeneratedBrief:
    path: Path


@dataclass(frozen=True)
class AttachedArtifact:
    artifact: Artifact
    path: Path


@dataclass(frozen=True)
class RecordedVerification:
    record: VerificationRecord
    path: Path


@dataclass(frozen=True)
class GeneratedReport:
    path: Path


@dataclass(frozen=True)
class GeneratedMemoryDiff:
    diff: MemoryDiff
    path: Path


def initialize_state(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute(CREATE_TASKS_TABLE)
        connection.commit()


def count_tasks(db_path: Path) -> int:
    if not db_path.exists():
        return 0
    with sqlite3.connect(db_path) as connection:
        row = connection.execute("SELECT COUNT(*) FROM tasks").fetchone()
    return int(row[0])


def infer_title(user_request: str) -> str:
    normalized = " ".join(user_request.strip().split())
    if not normalized:
        raise InvalidTaskRequestError("Cannot create task: User request must not be empty.")

    title = normalized
    sentence_ends = [
        index
        for index in (title.find("."), title.find("?"), title.find("!"))
        if index > 0
    ]
    if sentence_ends:
        title = title[: min(sentence_ends)].strip()

    max_length = 64
    if len(title) <= max_length:
        return title

    shortened = title[:max_length].rsplit(" ", 1)[0].strip()
    return f"{shortened or title[:max_length]}..."


def default_plan_for_task(task_id: str) -> Plan:
    return Plan(
        task_id=task_id,
        nodes=[
            PlanNode(
                id="intake_review",
                title="Intake Review",
                type="intake",
                depends_on=[],
                instructions=[
                    "Review task_spec.yaml",
                    "Identify assumptions and missing context",
                    "Do not expand scope unnecessarily",
                ],
                expected_output="Clarified assumptions and scope",
            ),
            PlanNode(
                id="implementation_or_investigation",
                title="Implementation or Investigation",
                type="execution",
                depends_on=["intake_review"],
                instructions=[
                    "Inspect relevant files",
                    "Make the smallest useful change or investigation note",
                    "Avoid unrelated changes",
                ],
                expected_output="Result artifact or code change summary",
            ),
            PlanNode(
                id="verification",
                title="Verification",
                type="verification",
                depends_on=["implementation_or_investigation"],
                instructions=[
                    "Run available tests or explain why tests cannot be run",
                    "Record commands and results",
                ],
                expected_output="Verification evidence",
            ),
            PlanNode(
                id="reporting",
                title="Reporting",
                type="reporting",
                depends_on=["verification"],
                instructions=[
                    "Summarize what changed, why, and remaining risks",
                ],
                expected_output="Final result summary",
            ),
        ],
    )


class TaskRepository:
    def __init__(self, paths: WorkspacePaths) -> None:
        self.paths = paths

    def create_task(self, user_request: str) -> CreatedTask:
        initialize_state(self.paths.state_path)

        task_id = self.next_task_id()
        task_dir = self.paths.task_dir(task_id)
        task_dir.mkdir(parents=True, exist_ok=False)
        artifacts_dir = task_dir / "artifacts"
        artifacts_dir.mkdir()

        now = utc_now_iso()
        spec = TaskSpec(
            id=task_id,
            title=infer_title(user_request),
            user_request=user_request,
            status=TaskStatus.DRAFT,
            created_at=now,
            updated_at=now,
        )
        write_yaml(task_dir / "task_spec.yaml", spec)
        self.upsert_task(spec, task_dir)
        return CreatedTask(spec=spec, task_dir=task_dir)

    def create_plan(self, task_id: str) -> GeneratedPlan:
        spec, task_dir = self.load_task_spec(task_id)
        plan = default_plan_for_task(task_id)
        plan_path = task_dir / "plan.yaml"
        write_yaml(plan_path, plan)
        self.update_task_status(spec, task_dir, TaskStatus.PLANNED)
        return GeneratedPlan(plan=plan, path=plan_path)

    def create_worker_brief(self, task_id: str, worker: str) -> GeneratedBrief:
        if worker != "codex":
            raise UnsupportedWorkerError(
                f"Unsupported worker: {worker}. Supported workers: codex"
            )

        spec, task_dir = self.load_task_spec(task_id)
        plan_path = task_dir / "plan.yaml"
        if not plan_path.exists():
            raise MissingPlanError(
                f"Plan not found for {task_id}. Run `ops task plan {task_id}` first."
            )

        plan = Plan.model_validate(read_yaml(plan_path))
        brief_path = task_dir / "worker_brief_codex.md"
        brief_path.write_text(
            render_codex_worker_brief(spec=spec, plan=plan),
            encoding="utf-8",
        )
        self.update_task_status(spec, task_dir, TaskStatus.BRIEFED)
        return GeneratedBrief(path=brief_path)

    def attach_result(self, task_id: str, source_path: Path) -> AttachedArtifact:
        spec, task_dir = self.load_task_spec(task_id)
        if not source_path.is_file():
            raise MissingResultFileError(f"Result file not found: {source_path}")

        artifacts_dir = task_dir / "artifacts"
        artifacts_dir.mkdir(exist_ok=True)
        destination = self._available_artifact_path(artifacts_dir, source_path.name)
        copy2(source_path, destination)

        artifacts = self.load_artifacts(task_dir)
        artifact = Artifact(
            id=self.next_artifact_id(artifacts),
            task_id=task_id,
            type="result",
            path=str(destination.relative_to(task_dir)),
            summary=f"Attached result file {source_path.name}",
        )
        artifacts.append(artifact)
        write_yaml(
            task_dir / "artifacts.yaml",
            {"artifacts": [item.model_dump(mode="json") for item in artifacts]},
        )
        self.update_task_status(spec, task_dir, TaskStatus.RESULT_ATTACHED)
        return AttachedArtifact(artifact=artifact, path=destination)

    def record_verification(
        self, task_id: str, status: str, note: str
    ) -> RecordedVerification:
        spec, task_dir = self.load_task_spec(task_id)
        normalized_status = status.strip().lower()
        task_status = verification_status_to_task_status(normalized_status)
        record_path = task_dir / "verification_record.yaml"

        if record_path.exists():
            record = VerificationRecord.model_validate(read_yaml(record_path))
        else:
            record = VerificationRecord(task_id=task_id, status=normalized_status)

        command = VerificationCommand(
            command="manual",
            status=normalized_status,
            note=note,
        )
        updated_record = record.model_copy(
            update={
                "status": normalized_status,
                "commands": [*record.commands, command],
                "notes": [*record.notes, note] if note else record.notes,
            }
        )
        write_yaml(record_path, updated_record)
        self.update_task_status(spec, task_dir, task_status)
        return RecordedVerification(record=updated_record, path=record_path)

    def list_tasks(self) -> list[TaskRow]:
        if not self.paths.state_path.exists():
            return []

        with sqlite3.connect(self.paths.state_path) as connection:
            rows = connection.execute(
                """
                SELECT id, title, status, created_at, updated_at, task_dir
                FROM tasks
                ORDER BY created_at ASC
                """
            ).fetchall()

        return [
            TaskRow(
                id=str(row[0]),
                title=str(row[1]),
                status=str(row[2]),
                created_at=str(row[3]),
                updated_at=str(row[4]),
                task_dir=str(row[5]),
            )
            for row in rows
        ]

    def generate_final_report(self, task_id: str) -> GeneratedReport:
        spec, task_dir = self.load_task_spec(task_id)
        plan = self.load_plan(task_dir)
        artifacts = self.load_artifacts(task_dir)
        verification = self.load_verification_record(task_dir)

        report_spec = spec
        if verification and verification.status == "passed":
            report_spec = self.update_task_status(spec, task_dir, TaskStatus.COMPLETED)
        else:
            self.upsert_task(spec, task_dir)

        report_path = task_dir / "final_report.md"
        report_path.write_text(
            render_final_report(
                spec=report_spec,
                plan=plan,
                artifacts=artifacts,
                verification=verification,
            ),
            encoding="utf-8",
        )
        return GeneratedReport(path=report_path)

    def propose_memory_diff(self, task_id: str) -> GeneratedMemoryDiff:
        spec, task_dir = self.load_task_spec(task_id)
        final_report_path = task_dir / "final_report.md"
        final_report_exists = final_report_path.exists()
        final_report_text = (
            final_report_path.read_text(encoding="utf-8")
            if final_report_exists
            else ""
        )

        diff = MemoryDiff(
            task_id=task_id,
            add=["No automatic memory additions proposed."],
            update=["Review this proposal before changing project memory."],
            deprecate=["No deprecations proposed."],
            do_not_store=[
                "Secrets, credentials, tokens, or private keys.",
                "Unverified guesses or assumptions.",
                "Transient implementation details that do not affect future work.",
            ],
            evidence=[
                f"task_spec.yaml: {spec.title}",
                "final_report.md loaded"
                if final_report_text
                else "final_report.md not found",
            ],
        )
        diff_path = task_dir / "memory_diff.md"
        diff_path.write_text(
            render_memory_diff(diff=diff, final_report_exists=final_report_exists),
            encoding="utf-8",
        )
        return GeneratedMemoryDiff(diff=diff, path=diff_path)

    def load_task_spec(self, task_id: str) -> tuple[TaskSpec, Path]:
        task_dir = self.paths.task_dir(task_id)
        spec_path = task_dir / "task_spec.yaml"
        if not spec_path.exists():
            raise TaskNotFoundError(f"Task {task_id} not found.")
        return TaskSpec.model_validate(read_yaml(spec_path)), task_dir

    def load_plan(self, task_dir: Path) -> Plan | None:
        plan_path = task_dir / "plan.yaml"
        if not plan_path.exists():
            return None
        return Plan.model_validate(read_yaml(plan_path))

    def load_artifacts(self, task_dir: Path) -> list[Artifact]:
        artifacts_path = task_dir / "artifacts.yaml"
        if not artifacts_path.exists():
            return []

        data = read_yaml(artifacts_path)
        return [Artifact.model_validate(item) for item in data.get("artifacts", [])]

    def load_verification_record(self, task_dir: Path) -> VerificationRecord | None:
        record_path = task_dir / "verification_record.yaml"
        if not record_path.exists():
            return None
        return VerificationRecord.model_validate(read_yaml(record_path))

    def update_task_status(
        self, spec: TaskSpec, task_dir: Path, status: TaskStatus
    ) -> TaskSpec:
        updated = spec.model_copy(
            update={"status": status, "updated_at": utc_now_iso()}
        )
        write_yaml(task_dir / "task_spec.yaml", updated)
        self.upsert_task(updated, task_dir)
        return updated

    def next_artifact_id(self, artifacts: list[Artifact]) -> str:
        numbers: list[int] = []
        for artifact in artifacts:
            if not artifact.id.startswith("ARTIFACT-"):
                continue
            suffix = artifact.id.removeprefix("ARTIFACT-")
            if suffix.isdigit():
                numbers.append(int(suffix))
        return f"ARTIFACT-{max(numbers, default=0) + 1:04d}"

    def next_task_id(self) -> str:
        existing_numbers = self._existing_task_numbers()
        next_number = max(existing_numbers, default=0) + 1
        return f"TASK-{next_number:04d}"

    def upsert_task(self, spec: TaskSpec, task_dir: Path) -> None:
        initialize_state(self.paths.state_path)
        with sqlite3.connect(self.paths.state_path) as connection:
            connection.execute(
                """
                INSERT INTO tasks (id, title, status, created_at, updated_at, task_dir)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    task_dir = excluded.task_dir
                """,
                (
                    spec.id,
                    spec.title,
                    spec.status.value,
                    spec.created_at,
                    spec.updated_at,
                    str(task_dir),
                ),
            )
            connection.commit()

    def _existing_task_numbers(self) -> list[int]:
        task_ids = set(self._task_ids_from_database())

        if self.paths.tasks_dir.exists():
            task_ids.update(
                path.name for path in self.paths.tasks_dir.iterdir() if path.is_dir()
            )

        numbers: list[int] = []
        for task_id in task_ids:
            if not task_id.startswith("TASK-"):
                continue
            suffix = task_id.removeprefix("TASK-")
            if suffix.isdigit():
                numbers.append(int(suffix))
        return numbers

    def _task_ids_from_database(self) -> list[str]:
        if not self.paths.state_path.exists():
            return []
        with sqlite3.connect(self.paths.state_path) as connection:
            rows = connection.execute("SELECT id FROM tasks").fetchall()
        return [str(row[0]) for row in rows]

    def _available_artifact_path(self, artifacts_dir: Path, filename: str) -> Path:
        destination = artifacts_dir / filename
        if not destination.exists():
            return destination

        stem = destination.stem
        suffix = destination.suffix
        counter = 2
        while True:
            candidate = artifacts_dir / f"{stem}-{counter}{suffix}"
            if not candidate.exists():
                return candidate
            counter += 1


def verification_status_to_task_status(status: str) -> TaskStatus:
    if status == "passed":
        return TaskStatus.VERIFIED
    if status == "failed":
        return TaskStatus.FAILED
    if status == "blocked":
        return TaskStatus.BLOCKED
    raise InvalidVerificationStatusError(
        f"Invalid verification status: {status}. Expected one of: passed, failed, blocked"
    )


def render_final_report(
    spec: TaskSpec,
    plan: Plan | None,
    artifacts: list[Artifact],
    verification: VerificationRecord | None,
) -> str:
    lines = [
        f"# Final Report: {spec.id}",
        "",
        "## Summary",
        f"- Title: {spec.title}",
        f"- Final task status: {spec.status.value}",
        "",
        "## User Request",
        spec.user_request,
        "",
        "## Success Criteria",
    ]
    lines.extend(f"- {criterion}" for criterion in spec.success_criteria)
    lines.extend(["", "## Plan"])

    if plan:
        for node in plan.nodes:
            lines.append(f"- {node.id}: {node.expected_output}")
    else:
        lines.append("- No plan.yaml found.")

    lines.extend(["", "## Artifacts"])
    if artifacts:
        for artifact in artifacts:
            lines.append(f"- {artifact.id}: {artifact.path} ({artifact.summary})")
    else:
        lines.append("- No artifacts registered.")

    lines.extend(["", "## Verification"])
    if verification:
        lines.append(f"- Status: {verification.status}")
        for command in verification.commands:
            lines.append(f"- {command.command}: {command.status} - {command.note}")
        for note in verification.notes:
            lines.append(f"- Note: {note}")
    else:
        lines.append("- No verification_record.yaml found.")

    lines.extend(["", "## Remaining Risks"])
    if verification and verification.remaining_risks:
        lines.extend(f"- {risk}" for risk in verification.remaining_risks)
    elif verification and verification.status == "passed":
        lines.append("- No remaining risks recorded.")
    else:
        lines.append("- Verification is missing, blocked, or failed.")

    lines.extend(["", "## Next Recommended Action"])
    if verification and verification.status == "passed":
        lines.append("- Review the memory diff proposal before updating project memory.")
    else:
        lines.append("- Resolve verification before treating this task as complete.")

    return "\n".join(lines).rstrip() + "\n"


def render_memory_diff(diff: MemoryDiff, final_report_exists: bool) -> str:
    lines = [
        f"# Proposed Memory Update: {diff.task_id}",
        "",
        "This is only a proposal. Do not write it to global project memory without review.",
        "It avoids secrets and unverified guesses.",
        "",
        "## Add",
    ]
    lines.extend(f"- {item}" for item in diff.add)
    lines.extend(["", "## Update"])
    lines.extend(f"- {item}" for item in diff.update)
    lines.extend(["", "## Deprecate"])
    lines.extend(f"- {item}" for item in diff.deprecate)
    lines.extend(["", "## Do Not Store"])
    lines.extend(f"- {item}" for item in diff.do_not_store)
    lines.extend(["", "## Evidence"])
    lines.extend(f"- {item}" for item in diff.evidence)
    if not final_report_exists:
        lines.append("- Generate final_report.md before applying any memory update.")

    return "\n".join(lines).rstrip() + "\n"


def render_codex_worker_brief(spec: TaskSpec, plan: Plan) -> str:
    lines = [
        "# Codex Worker Brief",
        "",
        f"Task ID: {spec.id}",
        f"Title: {spec.title}",
        "",
        "## User Request",
        spec.user_request,
        "",
        "## Success Criteria",
    ]
    lines.extend(f"- {criterion}" for criterion in spec.success_criteria)
    lines.extend(["", "## Constraints"])
    lines.extend(f"- {constraint}" for constraint in spec.constraints)
    lines.extend(
        [
            "- Do not make unrelated changes.",
            "",
            "## Plan Nodes",
        ]
    )

    for node in plan.nodes:
        dependencies = ", ".join(node.depends_on) if node.depends_on else "none"
        lines.extend(
            [
                f"### {node.id}: {node.title}",
                f"- Type: {node.type}",
                f"- Depends on: {dependencies}",
                "- Instructions:",
            ]
        )
        lines.extend(f"  - {instruction}" for instruction in node.instructions)
        lines.append(f"- Expected output: {node.expected_output}")
        lines.append("")

    lines.extend(
        [
            "## Required Output Format",
            "",
            "At the end of the task, report:",
            "- What changed",
            "- Files changed",
            "- Commands run",
            "- Tests passed, failed, or not run",
            "- Remaining risks",
            "",
            "Be concise, stay within the requested scope, and list every changed file.",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"
