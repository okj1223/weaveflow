from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULT_DOC = ROOT / "docs" / "poc_openclaw_real_invocation_result.md"
PLAN_DOC = ROOT / "docs" / "poc_openclaw_stdio_bridge_plan.md"


def test_poc_openclaw_real_invocation_result_exists() -> None:
    assert RESULT_DOC.exists()


def test_poc_openclaw_real_invocation_result_mentions_required_terms() -> None:
    doc = RESULT_DOC.read_text(encoding="utf-8")
    lower_doc = doc.lower()

    for term in [
        "projectops_stdio_poc",
        "OpenClaw",
        "real invocation",
        "workspaceRoot",
        "ping",
        "status",
        "create task",
        "pending confirmation",
        "task list",
        "shutdown",
        "remaining unknowns",
    ]:
        assert term.lower() in lower_doc

    assert "succeeded" in lower_doc or "blocked" in lower_doc


def test_poc_openclaw_real_invocation_result_records_closeout_contract() -> None:
    doc = RESULT_DOC.read_text(encoding="utf-8")

    for phrase in [
        "Real invocation through OpenClaw succeeded using the gateway `/tools/invoke`",
        "OpenClaw invoked the real\n`projectops_stdio_poc` tool through `/tools/invoke`",
        "Successful invocation required `workspaceRoot` to point to an initialized\n  ProjectOps workspace",
        "Stale `--dev` profile paths and stale repository `.projectops` paths are\n  local environment/workspace hygiene issues, not blockers",
        "optional manual validation, not a reason to add new code",
        "does not start a\nnew architecture phase",
    ]:
        assert phrase in doc

    for phrase in [
        "`ping` ok",
        "`status` ok",
        "`create task` returned pending confirmation",
        "`yes` confirmed task creation",
        "`task list` saw `TASK-0001`",
        "`shutdown` ok",
    ]:
        assert phrase in doc

    assert "WorkspaceNotFoundError" in doc


def test_poc_openclaw_stdio_bridge_plan_mentions_phase_12_b_result() -> None:
    doc = PLAN_DOC.read_text(encoding="utf-8")

    assert "PHASE 12-B" in doc or "real invocation result" in doc
