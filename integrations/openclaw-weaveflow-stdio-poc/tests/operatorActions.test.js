import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPERATOR_ACTION_SAFETY,
  buildActionToken,
  buildOperatorActionMenu,
  classifyOperatorActionSafety,
  executeOperatorAction,
  renderActionMenuKo,
  renderActionResultKo,
  validateActionToken
} from "../src/operatorActions.js";
import { writeJsonAtomic } from "../src/jobArtifacts.js";
import { writeChainStatus } from "../src/jobChain.js";

const NOW = "2026-05-22T08:30:00.000Z";
const BANNED_FALLBACK_TEXT = new RegExp([
  ["일반", "Codex", "장기", "세션"].join(" "),
  ["일반", "Codex로", "우회"].join(" "),
  ["Weaveflow가", "안", "되니", "Codex로", "돌리겠다"].join(" "),
  ["정책에서", "막혀서", "일반", "Codex로"].join(" ")
].join("|"));

test("operator action menu returns job and chain menus with tokens", async () => {
  const workspaceRoot = await mkWorkspace();
  const runningJobDir = await writeJob(workspaceRoot, "JOB-0001", {
    job_id: "JOB-0001",
    status: "running",
    current_step: "verification_pass",
    worker_started: true,
    pid: process.pid,
    updated_at: NOW
  });
  await writeJsonAtomic(join(runningJobDir, "heartbeat.json"), {
    schemaVersion: "weaveflow.heartbeat.v0",
    jobId: "JOB-0001",
    status: "running",
    currentStep: "verification_pass",
    lastHeartbeatAt: NOW,
    pid: process.pid
  });
  await writeJsonAtomic(join(runningJobDir, "job_status.json"), {
    schemaVersion: "weaveflow.job_status.v0",
    jobId: "JOB-0001",
    status: "running",
    phase: "verification_pass",
    workerStarted: true,
    workerExited: false,
    updatedAt: NOW,
    pid: process.pid
  });
  await writeFile(join(runningJobDir, "session_log.jsonl"), `${JSON.stringify({
    schemaVersion: "weaveflow.session_log.v0",
    ts: NOW,
    event: "heartbeat",
    jobId: "JOB-0001"
  })}\n`, "utf8");
  await writeJob(workspaceRoot, "JOB-0002", {
    job_id: "JOB-0002",
    chain_id: "CHAIN-0001",
    status: "limit_reached",
    stop_reason: "usage_limit_detected",
    recommended_next_action: "recover_after_limit_reset",
    current_step: "checkpoint",
    updated_at: NOW,
    resume_capsule_path: join(workspaceRoot, ".weaveflow", "jobs", "JOB-0002", "resume_capsule.md"),
    resume_capsule_json_path: join(workspaceRoot, ".weaveflow", "jobs", "JOB-0002", "resume_capsule.json")
  }, { resume: true });
  await writeChain(workspaceRoot, {
    chainId: "CHAIN-0001",
    rootJobId: "JOB-0002",
    currentJobId: "JOB-0002",
    status: "stopped_by_usage_limit",
    stopReason: "usage_limit_detected",
    recommendedNextAction: "recover_after_limit_reset",
    lastResumeCapsulePath: join(workspaceRoot, ".weaveflow", "jobs", "JOB-0002", "resume_capsule.md"),
    segmentIndex: 2,
    maxSegments: 6,
    runProfile: "company"
  });

  const jobMenu = await buildOperatorActionMenu({ workspaceRoot, jobId: "JOB-0001", now: NOW });
  assert.equal(jobMenu.actions.some((entry) => entry.action === "check"), true);
  assert.equal(jobMenu.actions.some((entry) => entry.action === "cancel_job"), true);
  assert.ok(jobMenu.actions.find((entry) => entry.action === "cancel_job").actionToken);

  const chainMenu = await buildOperatorActionMenu({ workspaceRoot, chainId: "CHAIN-0001", now: NOW });
  assert.equal(chainMenu.actions.some((entry) => entry.action === "inspect"), true);
  assert.equal(chainMenu.actions.some((entry) => entry.action === "show_next_prompt"), true);
  assert.equal(chainMenu.actions.some((entry) => entry.action === "prepare_recover"), true);
  assert.equal(chainMenu.actions.some((entry) => entry.action === "recover"), true);
  assert.match(renderActionMenuKo(chainMenu), /confirm=true \+ actionToken/);
  assert.doesNotMatch(renderActionMenuKo(chainMenu), BANNED_FALLBACK_TEXT);
});

test("operator action safety classification separates read-only, safe mutation, controlled worker start, and denied actions", () => {
  for (const action of ["inspect", "check", "show_next_prompt", "open_report"]) {
    assert.equal(classifyOperatorActionSafety(action), OPERATOR_ACTION_SAFETY.READ_ONLY);
  }
  for (const action of ["prepare_recover", "mark_reviewed", "pause_chain", "cancel_job"]) {
    assert.equal(classifyOperatorActionSafety(action), OPERATOR_ACTION_SAFETY.SAFE_MUTATION);
  }
  for (const action of ["recover", "continue_next_segment"]) {
    assert.equal(classifyOperatorActionSafety(action), OPERATOR_ACTION_SAFETY.CONTROLLED_WORKER_START);
  }
  for (const action of ["push", "deploy", "secret_change", "destructive_db_migration", "uncontrolled_commit", "force_push"]) {
    assert.equal(classifyOperatorActionSafety(action), OPERATOR_ACTION_SAFETY.DANGEROUS_DENIED);
  }
});

test("action tokens reject expired, mismatched, and already executed requests", async () => {
  const workspaceRoot = await mkWorkspace();
  await writeJob(workspaceRoot, "JOB-0001", { job_id: "JOB-0001", status: "needs_user_review" }, { resume: true });
  await writeJob(workspaceRoot, "JOB-0002", { job_id: "JOB-0002", status: "needs_user_review" }, { resume: true });

  const expired = await buildActionToken("recover", { workspaceRoot, jobId: "JOB-0001" }, {
    now: NOW,
    expiresAt: "2026-05-22T08:00:00.000Z"
  });
  assert.equal((await validateActionToken(expired.actionId, {
    workspaceRoot,
    jobId: "JOB-0001",
    action: "recover",
    now: NOW
  })).status, "action_token_expired");

  const mismatch = await buildActionToken("recover", { workspaceRoot, jobId: "JOB-0001" }, { now: NOW });
  assert.equal((await validateActionToken(mismatch.actionId, {
    workspaceRoot,
    jobId: "JOB-0002",
    action: "recover",
    now: NOW
  })).status, "action_token_job_mismatch");

  const token = await buildActionToken("recover", { workspaceRoot, jobId: "JOB-0001" }, { now: NOW });
  let recoverCalled = 0;
  const result = await executeOperatorAction({
    workspaceRoot,
    action: "recover",
    jobId: "JOB-0001",
    confirm: true,
    actionToken: token.actionId
  }, {
    workspaceRoot,
    recoverWeaveflowCodexJob: async () => {
      recoverCalled += 1;
      return {
        ok: true,
        jobId: "JOB-0001",
        nextJobId: "JOB-0003",
        chainId: "CHAIN-0001",
        resumeCapsulePath: join(workspaceRoot, ".weaveflow", "jobs", "JOB-0001", "resume_capsule.md"),
        nextSegment: {
          actionOutcome: "started_job",
          jobId: "JOB-0003",
          segmentIndex: 2,
          maxSegments: 6,
          status: "running"
        }
      };
    }
  });
  assert.equal(recoverCalled, 1);
  assert.equal(result.status, "recover_started_next_segment");
  assert.equal((await validateActionToken(token.actionId, {
    workspaceRoot,
    jobId: "JOB-0001",
    action: "recover",
    now: NOW
  })).status, "action_token_already_executed");
});

test("prepare_recover writes recovery plan and recover preview does not start worker without confirm token", async () => {
  const workspaceRoot = await mkWorkspace();
  await writeJob(workspaceRoot, "JOB-0001", {
    job_id: "JOB-0001",
    status: "needs_user_review",
    stop_reason: "max_session_minutes_reached",
    recommended_next_action: "continue"
  }, { resume: true });

  const plan = await executeOperatorAction({
    workspaceRoot,
    action: "prepare_recover",
    jobId: "JOB-0001",
    confirm: true
  }, { workspaceRoot });
  assert.equal(plan.status, "recovery_plan_prepared");
  assert.match(await readFile(plan.recoveryPlanPath, "utf8"), /Operator Recovery Plan/);
  assert.equal(JSON.parse(await readFile(plan.recoveryPlanJsonPath, "utf8")).jobId, "JOB-0001");

  let called = false;
  const preview = await executeOperatorAction({
    workspaceRoot,
    action: "recover",
    jobId: "JOB-0001"
  }, {
    workspaceRoot,
    recoverWeaveflowCodexJob: async () => {
      called = true;
    }
  });
  assert.equal(called, false);
  assert.equal(preview.status, "preview");
  assert.match(renderActionResultKo(preview), /아직 worker는 시작되지 않았습니다/);
});

test("continue_next_segment blocks usage-limit pause and cancel/pause/mark actions write only operator artifacts", async () => {
  const workspaceRoot = await mkWorkspace();
  const jobDir = await writeJob(workspaceRoot, "JOB-0001", {
    job_id: "JOB-0001",
    chain_id: "CHAIN-0001",
    status: "limit_reached",
    stop_reason: "usage_limit_detected",
    recommended_next_action: "recover_after_limit_reset"
  }, { resume: true });
  await writeChain(workspaceRoot, {
    chainId: "CHAIN-0001",
    rootJobId: "JOB-0001",
    currentJobId: "JOB-0001",
    status: "stopped_by_usage_limit",
    stopReason: "usage_limit_detected",
    recommendedNextAction: "recover_after_limit_reset",
    lastResumeCapsulePath: join(jobDir, "resume_capsule.md"),
    segmentIndex: 1,
    maxSegments: 6,
    runProfile: "company"
  });

  const continueToken = await buildActionToken("continue_next_segment", { workspaceRoot, chainId: "CHAIN-0001" }, { now: NOW });
  const blocked = await executeOperatorAction({
    workspaceRoot,
    action: "continue_next_segment",
    chainId: "CHAIN-0001",
    confirm: true,
    actionToken: continueToken.actionId
  }, {
    workspaceRoot,
    recoverWeaveflowCodexJob: async () => {
      throw new Error("should not call recover");
    }
  });
  assert.equal(blocked.status, "blocked_usage_limit_pause");
  assert.equal(blocked.workerStarted, false);

  const cancel = await executeOperatorAction({
    workspaceRoot,
    action: "cancel_job",
    jobId: "JOB-0001",
    confirm: true
  }, { workspaceRoot });
  assert.equal(cancel.status, "cancel_requested");
  assert.match(await readFile(join(jobDir, "cancel_request.json"), "utf8"), /operator_cancel_job/);

  const pause = await executeOperatorAction({
    workspaceRoot,
    action: "pause_chain",
    chainId: "CHAIN-0001",
    confirm: true
  }, { workspaceRoot });
  assert.equal(pause.status, "chain_paused");
  assert.equal(pause.runningWorkerCancelled, false);

  const beforeState = await readFile(join(jobDir, "job.yaml"), "utf8");
  const reviewed = await executeOperatorAction({
    workspaceRoot,
    action: "mark_reviewed",
    jobId: "JOB-0001",
    confirm: true
  }, { workspaceRoot });
  assert.equal(reviewed.status, "marked_reviewed");
  assert.equal(await readFile(join(jobDir, "job.yaml"), "utf8"), beforeState);
});

test("truthfulness actions do not fake missing reports, missing capsules, or dangerous actions", async () => {
  const workspaceRoot = await mkWorkspace();
  await writeJob(workspaceRoot, "JOB-0001", {
    job_id: "JOB-0001",
    status: "blocked_weaveflow_runtime_unavailable",
    action_outcome: "blocked_weaveflow_runtime_unavailable"
  });

  const report = await executeOperatorAction({
    workspaceRoot,
    action: "open_report",
    jobId: "JOB-0001"
  }, { workspaceRoot });
  assert.equal(report.status, "report_missing");
  assert.match(renderActionResultKo(report), /꾸며내지 않았습니다/);

  const prompt = await executeOperatorAction({
    workspaceRoot,
    action: "show_next_prompt",
    jobId: "JOB-0001"
  }, { workspaceRoot });
  assert.equal(prompt.status, "missing_resume_capsule");
  assert.equal(prompt.fallbackUsed, true);

  const denied = await executeOperatorAction({
    workspaceRoot,
    action: "push",
    jobId: "JOB-0001",
    confirm: true
  }, { workspaceRoot });
  assert.equal(denied.status, "dangerous_denied");
  assert.doesNotMatch(renderActionResultKo(denied), BANNED_FALLBACK_TEXT);
});

async function mkWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-operator-actions-"));
  await mkdir(join(workspaceRoot, ".weaveflow", "jobs"), { recursive: true });
  return workspaceRoot;
}

async function writeJob(workspaceRoot, jobId, state, options = {}) {
  const jobDir = join(workspaceRoot, ".weaveflow", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });
  await writeJsonAtomic(join(jobDir, "job.yaml"), {
    job_id: jobId,
    current_step: "checkpoint",
    updated_at: NOW,
    ...state
  });
  await writeFile(join(jobDir, "events.jsonl"), `${JSON.stringify({ timestamp: NOW, event: "job_created" })}\n`, "utf8");
  await writeJsonAtomic(join(jobDir, "start_outcome.json"), {
    status: state.status || "unknown",
    action_outcome: state.action_outcome || state.status || "unknown",
    jobId
  });
  if (options.resume) {
    await writeJsonAtomic(join(jobDir, "resume_capsule.json"), {
      resume_capsule_path: join(jobDir, "resume_capsule.md"),
      stop_reason: state.stop_reason || "max_session_minutes_reached",
      recommended_next_action: state.recommended_next_action || "continue",
      next_suggested_prompt: `Continue ${jobId} safely.`
    });
    await writeFile(join(jobDir, "resume_capsule.md"), `# Resume Capsule\n\nNext suggested prompt\n\nContinue ${jobId} safely.\n`, "utf8");
  }
  return jobDir;
}

async function writeChain(workspaceRoot, chain) {
  const jobsRoot = join(workspaceRoot, ".weaveflow", "jobs");
  await writeChainStatus(jobsRoot, {
    schemaVersion: "weaveflow.job_chain.v0",
    totalJobBudgetMinutes: 240,
    consumedBudgetMinutes: 45,
    remainingBudgetMinutes: 195,
    continuationMode: "auto_after_clean_segment",
    ...chain
  });
}
