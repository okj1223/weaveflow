"""Typer CLI for Weaveflow."""

from __future__ import annotations

from pathlib import Path

import typer

from weaveflow import service
from weaveflow.errors import WeaveflowError
from weaveflow.json_io import CONTRACT_VERSION, dumps_json
from weaveflow.paths import workspace_paths


app = typer.Typer(help="Local-first Weaveflow MVP.")
task_app = typer.Typer(help="Create and inspect local task records.")
memory_app = typer.Typer(help="Propose local memory changes.")
app.add_typer(task_app, name="task")
app.add_typer(memory_app, name="memory")


def exit_with_error(error: WeaveflowError) -> None:
    typer.echo(str(error), err=True)
    raise typer.Exit(1) from error


@app.command()
def init() -> None:
    """Create a local .weaveflow workspace."""
    paths = workspace_paths(Path.cwd())
    already_exists = paths.exists()
    service.init_workspace(Path.cwd())
    if already_exists:
        typer.echo(
            f"Weaveflow workspace already exists at {paths.root}; "
            "ensured required files and directories."
        )
    else:
        typer.echo(f"Initialized Weaveflow workspace at {paths.root}")


@app.command()
def status(
    json_output: bool = typer.Option(
        False,
        "--json",
        help="Print machine-readable JSON.",
    ),
) -> None:
    """Show local workspace status."""
    status_info = service.get_status(Path.cwd())
    if json_output:
        typer.echo(dumps_json(status_json_payload(status_info)))
        return

    exists = "yes" if status_info["workspace_exists"] else "no"
    typer.echo(f"{status_info['workspace_name']} exists: {exists}")
    typer.echo(f"workspace: {status_info['workspace_path']}")
    typer.echo(f"tasks: {status_info['task_count']}")
    typer.echo(f"state.sqlite: {status_info['state_path']}")
    typer.echo(f"memory: {status_info['memory_dir']}")
    if status_info["tasks"]:
        typer.echo("task statuses:")
        for task in status_info["tasks"]:
            typer.echo(f"- {task['id']}: {task['status']}")


@app.command()
def doctor(
    json_output: bool = typer.Option(
        False,
        "--json",
        help="Print machine-readable JSON.",
    ),
) -> None:
    """Inspect workspace health without modifying files."""
    report = service.doctor_workspace(Path.cwd())
    if json_output:
        typer.echo(dumps_json(doctor_json_payload(report)))
        if not report.healthy:
            raise typer.Exit(1)
        return

    for check in report.checks:
        typer.echo(f"{check.level.upper():<5} {check.message}")

    typer.echo("")
    typer.echo("Summary:")
    typer.echo(f"OK: {report.ok_count}")
    typer.echo(f"WARN: {report.warn_count}")
    typer.echo(f"ERROR: {report.error_count}")

    if not report.healthy:
        raise typer.Exit(1)


@task_app.command("create")
def task_create(user_request: str = typer.Argument(..., metavar="USER REQUEST")) -> None:
    """Create a draft task from a user request."""
    try:
        spec = service.create_task(Path.cwd(), user_request)
    except WeaveflowError as error:
        exit_with_error(error)

    typer.echo(f"Created task: {spec.id}")
    typer.echo(f"Path: {workspace_paths(Path.cwd()).task_dir(spec.id)}")


@task_app.command("show")
def task_show(task_id: str) -> None:
    """Show a readable task summary."""
    try:
        spec = service.show_task(Path.cwd(), task_id)
    except WeaveflowError as error:
        exit_with_error(error)

    task_dir = workspace_paths(Path.cwd()).task_dir(task_id)
    typer.echo(f"id: {spec.id}")
    typer.echo(f"title: {spec.title}")
    typer.echo(f"status: {spec.status.value}")
    typer.echo(f"user_request: {spec.user_request}")
    typer.echo("success_criteria:")
    for criterion in spec.success_criteria:
        typer.echo(f"- {criterion}")
    typer.echo("constraints:")
    for constraint in spec.constraints:
        typer.echo(f"- {constraint}")
    typer.echo(f"task directory: {task_dir}")


@task_app.command("list")
def task_list(
    json_output: bool = typer.Option(
        False,
        "--json",
        help="Print machine-readable JSON.",
    ),
) -> None:
    """List all tasks in creation order."""
    try:
        tasks = service.list_tasks(Path.cwd())
    except WeaveflowError as error:
        exit_with_error(error)

    if json_output:
        typer.echo(
            dumps_json(
                {
                    "contract_version": CONTRACT_VERSION,
                    "tasks": tasks,
                    "count": len(tasks),
                }
            )
        )
        return

    if not tasks:
        typer.echo("No tasks found.")
        return

    for task in tasks:
        typer.echo(
            f"{task.id} | {task.status} | {task.title} | "
            f"{task.created_at} | {task.updated_at}"
        )


@task_app.command("plan")
def task_plan(task_id: str) -> None:
    """Generate a default task plan."""
    try:
        service.create_plan(Path.cwd(), task_id)
    except WeaveflowError as error:
        exit_with_error(error)

    typer.echo(f"Plan: {workspace_paths(Path.cwd()).task_dir(task_id) / 'plan.yaml'}")


@task_app.command("brief")
def task_brief(
    task_id: str,
    worker: str = typer.Option("codex", "--worker", help="Worker brief target."),
) -> None:
    """Generate a worker brief from an existing plan."""
    try:
        brief_path = service.create_worker_brief(
            root=Path.cwd(),
            task_id=task_id,
            worker=worker,
        )
    except WeaveflowError as error:
        exit_with_error(error)

    typer.echo(f"Brief: {brief_path}")


@task_app.command("attach-result")
def task_attach_result(task_id: str, result_path: Path) -> None:
    """Attach a result file to a task artifact directory."""
    try:
        artifact = service.attach_result(
            root=Path.cwd(),
            task_id=task_id,
            result_path=result_path,
        )
    except WeaveflowError as error:
        exit_with_error(error)

    task_dir = workspace_paths(Path.cwd()).task_dir(task_id)
    typer.echo(f"Artifact: {task_dir / artifact.path}")


@task_app.command("verify")
def task_verify(
    task_id: str,
    status: str = typer.Option(..., "--status", help="passed, failed, or blocked."),
    note: str = typer.Option(..., "--note", help="Manual verification note."),
) -> None:
    """Record manual verification for a task."""
    try:
        service.verify_task(
            root=Path.cwd(),
            task_id=task_id,
            status=status,
            note=note,
        )
    except WeaveflowError as error:
        exit_with_error(error)

    record_path = (
        workspace_paths(Path.cwd()).task_dir(task_id) / "verification_record.yaml"
    )
    typer.echo(f"Verification: {record_path}")


@task_app.command("report")
def task_report(task_id: str) -> None:
    """Generate a final report for a task."""
    try:
        report_path = service.create_final_report(Path.cwd(), task_id)
    except WeaveflowError as error:
        exit_with_error(error)

    typer.echo(f"Final report: {report_path}")


@memory_app.command("propose")
def memory_propose(task_id: str) -> None:
    """Generate a conservative memory diff proposal."""
    try:
        diff_path = service.propose_memory_update(Path.cwd(), task_id)
    except WeaveflowError as error:
        exit_with_error(error)

    typer.echo(f"Memory diff: {diff_path}")


def status_json_payload(status_info: dict) -> dict:
    workspace_exists = bool(status_info["workspace_exists"])
    tasks = [
        {
            "id": task["id"],
            "title": task["title"],
            "status": task["status"],
            "created_at": task["created_at"],
            "updated_at": task["updated_at"],
        }
        for task in status_info["tasks"]
    ]
    return {
        "contract_version": CONTRACT_VERSION,
        "workspace_exists": workspace_exists,
        "workspace_path": str(status_info["workspace_path"]),
        "state_db_path": str(status_info["state_path"]) if workspace_exists else None,
        "memory_path": str(status_info["memory_dir"]) if workspace_exists else None,
        "task_count": status_info["task_count"],
        "tasks": tasks,
    }


def doctor_json_payload(report) -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "healthy": report.healthy,
        "ok_count": report.ok_count,
        "warn_count": report.warn_count,
        "error_count": report.error_count,
        "checks": report.checks,
    }
