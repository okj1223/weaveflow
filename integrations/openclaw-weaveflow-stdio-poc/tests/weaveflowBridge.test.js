import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CODEX_JOB_ACTION_OUTCOMES,
  CONTRACT_VERSION,
  buildInitialCodexJobPrompt,
  buildJobTimeline,
  buildJobPlanningArtifacts,
  buildCodexJobQualityReview,
  buildCodexAutomationPrompt,
  buildBridgeRequest,
  buildOpenClawLikePayload,
  buildPocRequests,
  cancelWeaveflowCodexJob,
  checkWeaveflowCodexJob,
  formatCodexAutomationSummary,
  formatCodexJobCancelSummary,
  formatCodexJobRecoverySummary,
  formatCodexJobStartSummary,
  formatCodexJobStatusSummary,
  initializeWeaveflowWorkspace,
  isBroadAutonomousRequest,
  jobStageDurations,
  recoverWeaveflowCodexJob,
  renderCodexJobResultMarkdown,
  resolveAutonomyMode,
  startWeaveflowCodexJob,
  runWeaveflowStdioPoc
} from "../src/weaveflowBridge.js";

test("bridge helper builds valid requests", () => {
  const request = buildBridgeRequest("bridge-1", "ping");
  assert.equal(request.contract_version, CONTRACT_VERSION);
  assert.equal(request.bridge_request_id, "bridge-1");
  assert.equal(request.type, "ping");
  assert.deepEqual(request.payload, {});

  const payload = buildOpenClawLikePayload("status", "message-1", "2026-05-10T00:00:00Z");
  assert.equal(payload.channelId, "openclaw-poc");
  assert.equal(payload.userId, "local-user");
  assert.equal(payload.messageId, "message-1");
  assert.equal(payload.content, "status");
  assert.equal(payload.createdAt, "2026-05-10T00:00:00Z");
  assert.equal(payload.threadId, "poc-thread");

  const requests = buildPocRequests({ taskText: "Bridge helper test task" });
  assert.equal(requests.length, 6);
  assert.deepEqual(
    requests.map((candidate) => candidate.type),
    ["ping", "handle_payload", "handle_payload", "handle_payload", "handle_payload", "shutdown"]
  );
  assert.match(requests[2].payload.content, /create task Bridge helper test task/);
});

test("Codex automation prompt keeps execution bounded to a temporary worktree", () => {
  const prompt = buildCodexAutomationPrompt({
    userRequest: "Create or update docs/codex_automation_poc_result.md.",
    taskSpec: "id: TASK-0001\n",
    plan: "task_id: TASK-0001\n",
    brief: "# Codex Worker Brief\n\nTask ID: TASK-0001\n",
    repoStatus: "HEAD: abc123 docs: prior\nController repo status:\n(clean)",
    branch: "codex/TASK-0001-create-doc"
  });

  assert.match(prompt, /Codex inside an isolated temporary git worktree/);
  assert.match(prompt, /isolated temporary git worktree/);
  assert.match(prompt, /Do not commit, push, merge/);
  assert.match(prompt, /Task ID: TASK-0001/);
  assert.match(prompt, /Target branch: codex\/TASK-0001-create-doc/);
  assert.match(prompt, /docs\/codex_automation_poc_result\.md/);
});

test("initial Codex job prompt fixes scope, safety policy, and stop conditions", () => {
  const originalRequest = "다 변경해. 내거는 그대로 두고 여자친구 단어세트들만 바꿔줘";
  const prompt = buildInitialCodexJobPrompt({
    userRequest: originalRequest,
    targetScope: ["여자친구 단어세트"],
    protectedScope: ["사용자/KJ 본인 단어세트"],
    runProfile: "company",
    allowPush: false,
    usageLimitGuard: {
      maxSessionMinutes: 45,
      totalJobBudgetMinutes: 240,
      checkpointEveryMinutes: 15
    }
  });

  assert.match(prompt, new RegExp(originalRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /여자친구 단어세트/);
  assert.match(prompt, /사용자\/KJ 본인 단어세트/);
  assert.match(prompt, /if target cannot be identified, stop and report/);
  assert.match(prompt, /allowPush=false/);
  assert.match(prompt, /Production deploy is forbidden/);
  assert.match(prompt, /Secret changes are forbidden/);
  assert.match(prompt, /Destructive DB migration is forbidden/);
  assert.match(prompt, /Discovery First/);
  assert.match(prompt, /Do not make a premature conclusion/);
  assert.match(prompt, /runProfile=company/);
});

test("Codex automation formatter returns Korean Discord-facing summary", () => {
  const text = formatCodexAutomationSummary({
    ok: true,
    taskId: "TASK-0001",
    branch: "codex/TASK-0001-create-doc",
    commitHash: "abc1234",
    pushed: true,
    changedFiles: ["docs/codex_automation_poc_result.md"],
    tests: {
      run: true,
      passed: true,
      checks: [{ name: "git diff --check" }]
    },
    resultArtifactPath: "/tmp/weaveflow/.weaveflow/tasks/TASK-0001/artifacts/codex_auto_run_result.md",
    shortSummary: "테스트 요약"
  });

  assert.match(text, /Weaveflow Codex 자동화 POC: 성공/);
  assert.match(text, /작업 ID: TASK-0001/);
  assert.match(text, /푸시 여부: 예/);
  assert.match(text, /테스트 결과: 통과/);
});

test("Codex job planning detects broad timeboxed work and selects a bounded scope", () => {
  assert.equal(isBroadAutonomousRequest("웹사이트 3시간 동안 강화해"), true);
  assert.equal(resolveAutonomyMode("auto", "Update docs/foo.md with X."), "specific");
  assert.equal(resolveAutonomyMode("auto", "Spend about 30 minutes improving docs yourself."), "timeboxed");

  const planning = buildJobPlanningArtifacts({
    userRequest: "Spend about 30 minutes improving the OpenClaw Codex documentation yourself.",
    autonomyMode: "timeboxed",
    timeBudgetMinutes: 30,
    scan: {
      projectTypes: ["Python package", "Node package", "documentation-heavy repo"],
      sourceDirs: ["src", "integrations"],
      docsDirs: ["docs", "integrations/openclaw-weaveflow-stdio-poc"],
      testDirs: ["tests"],
      pluginDirs: ["integrations/openclaw-weaveflow-stdio-poc"],
      testCommands: ["git diff --check", "npm test --prefix integrations/openclaw-weaveflow-stdio-poc"],
      buildCommands: []
    },
    intake: {
      original_request: "Spend about 30 minutes improving the OpenClaw Codex documentation yourself.",
      inferred_intent: "documentation",
      risk_level: "low",
      time_budget_minutes: 30
    },
    policy: {
      riskLevel: "low",
      runTests: true
    },
    verificationPlan: {
      mode: "fast",
      commands: [{ command: "git diff --check" }],
      korean_summary: "검증 계획: fast"
    }
  });

  assert.equal(planning.resolvedMode, "timeboxed");
  assert.match(planning.backlogMarkdown, /Opportunity Backlog/);
  assert.match(planning.backlogMarkdown, /docs-readme-usage-notes/);
  assert.match(planning.selectedScopeMarkdown, /Selected Scope/);
  assert.match(planning.selectedScopeMarkdown, /선택된 범위/);
  assert.match(planning.executionPlanMarkdown, /Execution Plan/);
  assert.match(planning.executionPlanMarkdown, /검증 계획: fast/);
});

test("Codex job quality review accepts docs-only scoped changes", () => {
  const review = buildCodexJobQualityReview({
    state: {
      user_request: "Update README usage notes for the OpenClaw Codex job runner.",
      normalized_goal: "OpenClaw Codex job runner README 사용성 설명 보강",
      job_policy: {
        riskLevel: "low",
        push: true,
        allowedActions: ["commit_changes", "push_branch"],
        maxFixAttempts: 1
      },
      max_fix_attempts: 1,
      session_mode: "single"
    },
    planning: {
      scopeSelection: {
        selectedItems: [
          {
            id: "readme-usage-notes",
            title: "README usage notes",
            likelyFiles: ["README.md"]
          }
        ],
        expectedCategories: ["docs"]
      },
      selectedScopeMarkdown: "# Selected Scope\n\n- README.md usage notes"
    },
    changedFiles: ["README.md"],
    tests: {
      run: true,
      passed: true,
      checks: [{ name: "git diff --check", passed: true }]
    },
    codexFinalMessage: "README 사용성 설명을 보강했고 git diff --check 검증이 통과했습니다."
  });

  assert.equal(review.changeReview.scope_alignment, "strong");
  assert.equal(review.qualityGate.decision, "accept");
  assert.equal(review.qualityGate.should_commit, true);
  assert.equal(review.qualityGate.should_push, true);
  assert.match(review.outcomeContract.markdown, /Outcome Contract/);
  assert.match(review.qualityGate.korean_summary, /품질 게이트: 승인/);
});

test("Codex job quality review requests a fix for unrelated scoped changes", () => {
  const review = buildCodexJobQualityReview({
    state: {
      user_request: "Update documentation only.",
      normalized_goal: "문서만 업데이트",
      job_policy: {
        riskLevel: "low",
        allowedActions: ["commit_changes"],
        maxFixAttempts: 1
      },
      max_fix_attempts: 1
    },
    planning: {
      scopeSelection: {
        selectedItems: [
          {
            id: "docs-only",
            title: "Docs-only update",
            likelyFiles: ["README.md"]
          }
        ],
        expectedCategories: ["docs"]
      }
    },
    changedFiles: ["README.md", "src/index.js"],
    tests: {
      run: true,
      passed: true,
      checks: [{ name: "git diff --check", passed: true }]
    },
    codexFinalMessage: "문서 업데이트 중 관련 소스 파일도 함께 수정했습니다."
  });

  assert.equal(review.changeReview.scope_alignment, "partial");
  assert.equal(review.changeReview.unrelated_changes.some((finding) => finding.file === "src/index.js"), true);
  assert.equal(review.qualityGate.decision, "needs_fix");
  assert.equal(review.qualityGate.should_commit, false);
  assert.match(review.qualityGate.recommended_fix_prompt, /가장 작은 범위/);
});

test("Codex job quality review rejects risky env changes before commit", () => {
  const review = buildCodexJobQualityReview({
    state: {
      user_request: "Update documentation only.",
      normalized_goal: "문서만 업데이트",
      job_policy: {
        riskLevel: "low",
        allowedActions: ["commit_changes", "push_branch"],
        maxFixAttempts: 2
      },
      max_fix_attempts: 2
    },
    planning: {
      scopeSelection: {
        selectedItems: [
          {
            id: "docs-only",
            title: "Docs-only update",
            likelyFiles: ["README.md"]
          }
        ],
        expectedCategories: ["docs"]
      }
    },
    changedFiles: [".env.production"],
    tests: {
      run: true,
      passed: true,
      checks: [{ name: "git diff --check", passed: true }]
    },
    codexFinalMessage: "문서 작업 중 .env.production 파일이 변경되었습니다."
  });

  assert.equal(review.qualityGate.decision, "reject");
  assert.equal(review.qualityGate.should_commit, false);
  assert.equal(review.qualityGate.should_push, false);
  assert.equal(review.qualityGate.reasons.includes("high_risk_change_detected"), true);
  assert.match(review.qualityGate.risky_changes.join("\n"), /\.env\.production/);
});

test("Codex job start creates file-based state without starting worker when requested", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-job-runner-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot: "weaveflow",
    userRequest: "Spend about 30 minutes improving the OpenClaw Codex documentation yourself.",
    timeBudgetMinutes: 30,
    autonomyMode: "timeboxed",
    push: false,
    runTests: true,
    maxFixAttempts: 2,
    startWorker: false
  });

  assert.match(start.jobId, /^JOB-\d{4}$/);
  assert.match(start.taskId, /^TASK-\d{4}$/);
  assert.match(start.branch, /^codex\/JOB-\d{4}-/);

  const jobState = JSON.parse(await readFile(join(start.jobDir, "job.yaml"), "utf8"));
  assert.equal(jobState.status, "queued");
  assert.equal(jobState.repo_root, repoRoot);
  assert.equal(jobState.repo_resolution.repoAlias, "weaveflow");
  assert.equal(jobState.job_policy.riskLevel, "low");
  assert.equal(jobState.job_policy.runTests, true);
  assert.equal(jobState.job_policy.maxFixAttempts, 2);
  assert.equal(jobState.job_policy.timeBudgetMinutes, 30);
  assert.equal(jobState.job_policy.maxSessionMinutes, 60);
  assert.equal(jobState.job_policy.totalJobBudgetMinutes, 30);
  assert.equal(jobState.job_policy.checkpointEveryMinutes, 20);
  assert.equal(jobState.job_policy.allowPush, false);
  assert.equal(jobState.run_profile, "focused");
  assert.equal(jobState.usage_limit_guard.runProfile, "focused");
  assert.equal(jobState.usage_limit_guard.maxFixAttempts, 2);
  assert.equal(jobState.usage_limit_guard.maxRepeatedFailures, 2);
  assert.equal(jobState.usage_limit_guard.totalJobBudgetMinutes, 30);
  assert.equal(jobState.usage_limit_guard.checkpointEveryMinutes, 20);
  assert.equal(jobState.usage_limit_guard.allowPush, false);
  assert.equal(jobState.time_budget_minutes, 30);
  assert.equal(jobState.max_session_minutes, 60);
  assert.equal(jobState.total_job_budget_minutes, 30);
  assert.equal(jobState.checkpoint_count, 1);
  assert.equal(jobState.latest_checkpoint_reason, "job_started");
  assert.equal(jobState.resume_capsule_path, join(start.jobDir, "resume_capsule.md"));
  assert.equal(jobState.next_suggested_prompt_ready, true);
  assert.equal(jobState.max_fix_attempts, 2);
  assert.equal(jobState.elapsed_ms >= 0, true);
  assert.equal(jobState.last_event, "outcome_contract_created");
  assert.equal(jobState.stage_timestamps.job_created.length > 0, true);
  assert.equal(jobState.outcome_contract_path, join(start.jobDir, "outcome_contract.md"));
  assert.equal(jobState.quality_review_status, "pending");
  assert.equal(jobState.action_outcome, CODEX_JOB_ACTION_OUTCOMES.DRY_RUN_PROMPT_ONLY);
  assert.equal(jobState.worker_started, false);
  assert.equal(jobState.initial_prompt_path, join(start.jobDir, "initial_prompt.md"));
  assert.equal(jobState.start_outcome_path, join(start.jobDir, "start_outcome.json"));
  assert.match(await readFile(join(start.jobDir, "outcome_contract.md"), "utf8"), /Outcome Contract/);
  assert.match(await readFile(join(start.jobDir, "usage_limit_guard.md"), "utf8"), /Usage Limit Guard/);
  assert.match(await readFile(join(start.jobDir, "resume_capsule.md"), "utf8"), /Resume Capsule/);
  assert.match(await readFile(join(start.jobDir, "checkpoints", "checkpoint-0001.md"), "utf8"), /Next Suggested Prompt/);
  assert.match(await readFile(join(start.jobDir, "initial_prompt.md"), "utf8"), /allowPush=false/);
  assert.equal(JSON.parse(await readFile(join(start.jobDir, "start_outcome.json"), "utf8")).action_outcome, CODEX_JOB_ACTION_OUTCOMES.DRY_RUN_PROMPT_ONLY);
  assert.equal(JSON.parse(await readFile(join(start.jobDir, "job_request.json"), "utf8")).allowPush, false);
  assert.equal(JSON.parse(await readFile(join(start.jobDir, "outcome_contract.json"), "utf8")).contract_id.length > 0, true);

  const rawEvents = (await readFile(join(start.jobDir, "events.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(rawEvents[0].event, "job_created");
  assert.equal(rawEvents[0].status, "queued");
  assert.equal(rawEvents[0].current_step, "queued");
  assert.equal(typeof rawEvents[0].timestamp, "string");

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(status.status, "queued");
  assert.equal(status.jobPolicy.riskLevel, "low");
  assert.equal(status.runProfile, "focused");
  assert.equal(status.checkpointCount, 1);
  assert.equal(status.latestCheckpointReason, "job_started");
  assert.equal(status.resumeCapsulePath, join(start.jobDir, "resume_capsule.md"));
  assert.equal(status.nextSuggestedPromptReady, true);
  assert.match(status.usageLimitSummary, /프로필: focused/);
  assert.equal(status.repoResolution.repoAlias, "weaveflow");
  assert.equal(status.elapsedMs >= 0, true);
  assert.deepEqual(Object.keys(status.stageDurations), ["planning", "codex", "tests", "fixes", "commit", "push"]);
  assert.match(formatCodexJobStartSummary(start), /worker 실행 상태가 아닙니다/);
  assert.match(formatCodexJobStartSummary(start), /dry_run_prompt_only/);
  assert.match(formatCodexJobStatusSummary(status), /Weaveflow Codex 작업 상태/);
  assert.match(formatCodexJobStatusSummary(status), /Codex 작업 정책/);
  assert.match(formatCodexJobStatusSummary(status), /Usage Limit Guard/);
  assert.match(formatCodexJobStatusSummary(status), /Checkpoint \/ Resume/);
  assert.match(formatCodexJobStatusSummary(status), /체크포인트: 1개/);
  assert.match(formatCodexJobStatusSummary(status), /재개 캡슐:/);
  assert.match(formatCodexJobStatusSummary(status), /push: 허용 안 됨/);
  assert.match(formatCodexJobStatusSummary(status), /품질 검토/);
  assert.match(formatCodexJobStatusSummary(status), /총 경과 시간:/);
  assert.match(formatCodexJobStatusSummary(status), /최근 이벤트:/);
  assert.match(formatCodexJobStatusSummary(status), /job_created/);

  const cancel = await cancelWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(cancel.cancelled, true);
  assert.match(formatCodexJobCancelSummary(cancel), /Weaveflow Codex 작업 취소/);
  assert.match(formatCodexJobCancelSummary(cancel), /취소 처리: 예/);

  const cancelledState = JSON.parse(await readFile(join(start.jobDir, "job.yaml"), "utf8"));
  assert.equal(cancelledState.status, "cancelled");
  assert.equal(cancelledState.last_event, "job_cancelled");
  assert.equal(cancelledState.latest_checkpoint_reason, "user_cancelled");
  assert.equal(cancelledState.checkpoint_count >= 2, true);
  assert.equal(cancelledState.elapsed_ms >= 0, true);
  assert.equal(cancelledState.stage_timestamps.job_cancelled.length > 0, true);
});

test("Codex job check includes recovery diagnostics for stale running job", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-stale-check-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const { jobDir } = await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0091",
    repoRoot,
    state: {
      status: "running",
      current_step: "codex_exec",
      pid: 999999,
      updated_at: "2026-05-12T10:00:00.000Z",
      worktree: "/tmp/weaveflow-missing-worktree-JOB-0091/repo",
      branch: "codex/JOB-0091-stale",
      error: null
    }
  });
  const runner = createRecoveryGitRunner();

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0091",
    recoveryNow: "2026-05-12T12:00:00.000Z",
    recoveryStaleAfterMs: 5 * 60 * 1000,
    recoveryProcessChecker: () => false,
    commandRunner: runner
  });

  assert.equal(status.recoveryDiagnostics.health, "stale_running");
  assert.equal(status.recovery.staleDetected, true);
  assert.equal(status.recoveryPlan.recovery_action, "mark_failed");
  assert.match(formatCodexJobStatusSummary(status), /복구 진단/);
  assert.match(formatCodexJobStatusSummary(status), /stale: yes/);
  assert.match(await readFile(join(jobDir, "recovery_diagnostics.md"), "utf8"), /Job State Diagnostics/);
  assert.match(await readFile(join(jobDir, "recovery_plan.md"), "utf8"), /Recovery Plan/);
});

test("Codex job check remains concise for queued healthy job", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-healthy-check-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "Update README docs.",
    push: false,
    startWorker: false
  });

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });

  assert.equal(status.recovery, null);
  assert.doesNotMatch(formatCodexJobStatusSummary(status), /복구 진단/);
});

test("Codex job start reports started_job only when worker process starts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-job-start-outcome-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const toeflRequest = "지금 여자친구가 대만인이라 실제 대만인들이 보는 토플단어책 느낌으로 뜻이 잘 쓰여져 있어야하는데(번역체ㄴㄴ) 지금은 그냥 죄다 한국어로 박혀있거든? 다 변경해. 내거는 그대로 두고 여자친구 단어세트들만 바꿔줘.";

  const started = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: toeflRequest,
    runTests: true,
    push: false,
    startWorkerProcess: async () => ({ pid: 12345 })
  });

  assert.equal(started.actionOutcome, CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB);
  assert.equal(started.status, "running");
  assert.equal(started.workerStarted, true);
  assert.equal(started.runProfile, "company");
  assert.equal(started.allowPush, false);
  assert.equal(started.protectedScope.some((scope) => /사용자\/KJ 본인/.test(scope)), true);
  assert.equal(started.targetScope.some((scope) => /여자친구.*단어세트/.test(scope)), true);

  const startedText = formatCodexJobStartSummary(started);
  assert.match(startedText, /Codex job을 시작했습니다/);
  assert.match(startedText, new RegExp(started.jobId));
  assert.match(startedText, /runProfile: company/);
  assert.match(startedText, /worker started: yes/);
  assert.match(startedText, /weaveflow_check_codex_job/);
  assert.match(startedText, /weaveflow_cancel_codex_job/);
  assert.match(startedText, /weaveflow_recover_codex_job/);
  assert.match(startedText, /initial prompt:/);
  assert.equal(JSON.parse(await readFile(join(started.jobDir, "start_outcome.json"), "utf8")).action_outcome, CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB);
  assert.match(await readFile(join(started.jobDir, "initial_prompt.md"), "utf8"), /if target cannot be identified, stop and report/);

  const failed = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "다 변경해. 내거는 그대로 두고 여자친구 단어세트들만 바꿔줘",
    push: false,
    startWorkerProcess: async () => {
      throw new Error("spawn denied");
    }
  });

  assert.equal(failed.actionOutcome, CODEX_JOB_ACTION_OUTCOMES.START_FAILED);
  assert.equal(failed.status, CODEX_JOB_ACTION_OUTCOMES.START_FAILED);
  assert.equal(failed.workerStarted, false);

  const failedText = formatCodexJobStartSummary(failed);
  assert.doesNotMatch(failedText, /Codex에 맡겼|Codex에 맡길게|작업 맡길게|진행시킬게|바로 돌릴게|백그라운드로 진행할게|시작했습니다/);
  assert.match(failedText, /status: start_failed/);
  assert.match(failedText, /reason: spawn denied/);
  assert.match(failedText, /user next action:/);
  assert.equal(JSON.parse(await readFile(join(failed.jobDir, "start_outcome.json"), "utf8")).action_outcome, CODEX_JOB_ACTION_OUTCOMES.START_FAILED);
});

test("Codex job recovery dry-run returns plan without mutating job state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-recovery-dry-run-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const { jobDir } = await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0092",
    repoRoot,
    state: {
      status: "running",
      current_step: "codex_exec",
      pid: 999998,
      updated_at: "2026-05-12T10:00:00.000Z",
      worktree: "/tmp/weaveflow-missing-worktree-JOB-0092/repo",
      branch: "codex/JOB-0092-stale"
    }
  });
  const before = await readFile(join(jobDir, "job.yaml"), "utf8");
  await writeFile(join(jobDir, "resume_capsule.md"), "# Resume Capsule\n\n준비됨\n", "utf8");
  await writeFile(join(jobDir, "resume_capsule.json"), JSON.stringify({
    job_id: "JOB-0092",
    run_profile: "company",
    current_phase: "codex_exec",
    stop_reason: "usage_limit_detected",
    current_objective: "Recover fake Codex job.",
    completed_work_summary: "일부 작업이 진행됨",
    changed_files: ["README.md"],
    checks_run: true,
    checks_passed: false,
    checks_failed: ["npm test"],
    latest_failure_signature: "npm test:same failure",
    repeated_failure_count: 1,
    fix_attempts_used: 1,
    remaining_budget_summary: { elapsed_minutes: 40, max_session_minutes: 45, total_job_budget_minutes: 240 },
    risks_unsafe_actions_skipped: [],
    latest_checkpoint_path: join(jobDir, "checkpoints", "checkpoint-0001.md"),
    checkpoint_count: 1,
    latest_checkpoint_reason: "usage_limit_detected",
    resume_capsule_path: join(jobDir, "resume_capsule.md"),
    recommended_next_action: "recover",
    next_suggested_prompt: "Continue Weaveflow Codex job JOB-0092 from the resume capsule."
  }, null, 2), "utf8");
  const runner = createRecoveryGitRunner();

  const result = await recoverWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0092",
    apply: false,
    commandRunner: runner,
    recoveryNow: "2026-05-12T12:00:00.000Z",
    recoveryProcessChecker: () => false
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.action, "mark_failed");
  assert.equal(result.resumeCapsulePath, join(jobDir, "resume_capsule.md"));
  assert.equal(result.recommendedNextAction, "recover");
  assert.equal(result.nextSuggestedPromptReady, true);
  assert.match(formatCodexJobRecoverySummary(result), /dry-run/);
  assert.match(formatCodexJobRecoverySummary(result), /재개 캡슐/);
  assert.match(formatCodexJobRecoverySummary(result), /Continue Weaveflow Codex job JOB-0092/);
  assert.match(await readFile(join(jobDir, "recovery_plan.md"), "utf8"), /Recovery Plan/);
  assert.match(await readFile(join(jobDir, "recovery_plan.md"), "utf8"), /Resume Capsule/);
  assert.equal(await readFile(join(jobDir, "job.yaml"), "utf8"), before);
  assert.equal(runner.calls.some((call) => call.args.includes("worktree")), true);
});

test("Codex job recovery refuses destructive cleanup by default", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-recovery-cleanup-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0093",
    repoRoot,
    state: {
      status: "completed",
      current_step: "completed",
      commit_hash: "abc1234",
      pushed: true,
      tests: { run: true, passed: true, checks: [] },
      worktree: "/tmp/weaveflow-clean-worktree-JOB-0093/repo",
      branch: "codex/JOB-0093-completed"
    },
    result: "# Result\n\n완료\n"
  });

  const result = await recoverWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0093",
    apply: true,
    action: "cleanup_completed_worktree",
    allowCleanup: false,
    commandRunner: createRecoveryGitRunner({
      worktreePath: "/tmp/weaveflow-clean-worktree-JOB-0093/repo",
      branch: "codex/JOB-0093-completed",
      worktreeExists: true,
      branchExists: true,
      status: "",
      head: "abc1234"
    })
  });

  assert.equal(result.applied, false);
  assert.equal(result.recoveryResult.reason, "cleanup_requires_allowCleanup_true");
  assert.match(formatCodexJobRecoverySummary(result), /보류/);
});

test("Codex job recovery reconstructs missing result artifact", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-recovery-reconstruct-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const { jobDir } = await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0094",
    repoRoot,
    state: {
      status: "completed",
      current_step: "completed",
      commit_hash: "abc1234",
      pushed: true,
      tests: { run: true, passed: true, checks: [{ name: "git diff --check", passed: true }] },
      worktree: "/tmp/weaveflow-clean-worktree-JOB-0094/repo",
      branch: "codex/JOB-0094-completed",
      result_artifact_path: join(workspaceRoot, ".weaveflow", "jobs", "JOB-0094", "result.md")
    },
    result: null
  });

  const result = await recoverWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0094",
    apply: true,
    action: "reconstruct_result",
    commandRunner: createRecoveryGitRunner({
      worktreePath: "/tmp/weaveflow-clean-worktree-JOB-0094/repo",
      branch: "codex/JOB-0094-completed",
      worktreeExists: true,
      branchExists: true,
      status: "",
      head: "abc1234"
    })
  });

  assert.equal(result.applied, true);
  assert.equal(result.action, "reconstruct_result");
  assert.match(await readFile(join(jobDir, "result.md"), "utf8"), /Weaveflow Codex Job Result/);
  assert.match(await readFile(join(jobDir, "recovery_result.md"), "utf8"), /Recovery Result/);
});

test("Codex job recovery can mark failed and requires strong evidence for mark completed", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-recovery-apply-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0095",
    repoRoot,
    state: {
      status: "running",
      current_step: "codex_exec",
      pid: 999997,
      worktree: "/tmp/weaveflow-missing-worktree-JOB-0095/repo",
      branch: "codex/JOB-0095-failed"
    }
  });
  await writeFakeCodexJob({
    workspaceRoot,
    jobId: "JOB-0096",
    repoRoot,
    state: {
      status: "running",
      current_step: "codex_exec",
      commit_hash: "abc1234",
      pushed: false,
      tests: { run: true, passed: false, checks: [{ name: "npm test", passed: false }] },
      worktree: "/tmp/weaveflow-clean-worktree-JOB-0096/repo",
      branch: "codex/JOB-0096-incomplete"
    },
    result: "# Result\n\n부분 완료\n"
  });

  const failed = await recoverWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0095",
    apply: true,
    action: "mark_failed",
    commandRunner: createRecoveryGitRunner()
  });
  const completed = await recoverWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: "JOB-0096",
    apply: true,
    action: "mark_completed",
    commandRunner: createRecoveryGitRunner({
      worktreePath: "/tmp/weaveflow-clean-worktree-JOB-0096/repo",
      branch: "codex/JOB-0096-incomplete",
      worktreeExists: true,
      branchExists: true,
      status: "",
      head: "abc1234"
    })
  });

  const failedState = JSON.parse(await readFile(join(workspaceRoot, ".weaveflow", "jobs", "JOB-0095", "job.yaml"), "utf8"));
  const completedState = JSON.parse(await readFile(join(workspaceRoot, ".weaveflow", "jobs", "JOB-0096", "job.yaml"), "utf8"));
  assert.equal(failed.applied, true);
  assert.equal(failedState.status, "failed");
  assert.equal(completed.applied, false);
  assert.match(completed.recoveryResult.reason, /mark_completed_requires_strong_evidence/);
  assert.equal(completedState.status, "running");
});

test("Codex job start uses normalized intake fields for metadata and branch naming", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-job-intake-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "Spend 45 minutes improving repo quality yourself.",
    autonomyMode: "auto",
    push: false,
    startWorker: false
  });

  const jobState = JSON.parse(await readFile(join(start.jobDir, "job.yaml"), "utf8"));
  assert.equal(jobState.time_budget_minutes, 45);
  assert.equal(jobState.autonomy_mode, "timeboxed");
  assert.equal(jobState.job_intake.time_budget_minutes, 45);
  assert.equal(jobState.job_intake.autonomy_mode, "timeboxed");
  assert.match(jobState.normalized_goal, /저장소 품질 개선/);
  assert.match(jobState.branch, new RegExp(`^codex/${start.jobId}-${jobState.job_intake.branch_slug}`));

  const goal = await readFile(join(start.jobDir, "goal.md"), "utf8");
  assert.match(goal, /Intake Summary/);
  assert.match(goal, /시간 예산: 45분/);
});

test("Codex job multi-step session creates session artifacts and Korean progress", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-session-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "Spend about 45 minutes improving the documentation around the Weaveflow OpenClaw Codex job runner.",
    sessionMode: "multi_step",
    timeBudgetMinutes: 45,
    maxSteps: 3,
    push: false,
    runTests: true,
    maxFixAttempts: 2,
    startWorker: false
  });

  assert.equal(start.sessionMode, "multi_step");
  assert.equal(start.totalSteps > 0, true);
  assert.equal(start.totalSteps <= 3, true);
  assert.equal(start.currentSessionStep.status, "pending");
  assert.match(formatCodexJobStartSummary(start), /세션 진행/);

  const jobState = JSON.parse(await readFile(join(start.jobDir, "job.yaml"), "utf8"));
  assert.equal(jobState.session_mode, "multi_step");
  assert.equal(jobState.total_steps, start.totalSteps);
  assert.equal(jobState.completed_steps, 0);
  assert.equal(jobState.failed_steps, 0);
  assert.equal(jobState.skipped_steps, 0);
  assert.equal(jobState.session_plan_path, join(start.jobDir, "session_plan.md"));
  assert.equal(jobState.session_summary_path, join(start.jobDir, "session_summary.md"));

  const sessionSteps = JSON.parse(await readFile(join(start.jobDir, "session_steps.json"), "utf8"));
  assert.equal(sessionSteps.length, start.totalSteps);
  assert.deepEqual(Object.keys(sessionSteps[0]).sort(), [
    "commit_hash",
    "estimated_minutes",
    "finished_at",
    "goal",
    "reason",
    "result_summary",
    "risk",
    "selected_files_hint",
    "started_at",
    "status",
    "step_id",
    "title",
    "value",
    "verification_commands"
  ].sort());
  assert.match(await readFile(join(start.jobDir, "session_plan.md"), "utf8"), /Multi-step Work Session Plan/);
  assert.match(await readFile(join(start.jobDir, "steps", "step-1", "step.md"), "utf8"), /^# step-1:/);

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(status.sessionMode, "multi_step");
  assert.equal(status.totalSteps, start.totalSteps);
  assert.match(formatCodexJobStatusSummary(status), /세션 진행/);
  assert.match(formatCodexJobStatusSummary(status), /현재 단계 목표:/);

  const cancel = await cancelWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.sessionMode, "multi_step");
  assert.equal(cancel.skippedSteps, start.totalSteps);
  assert.match(formatCodexJobCancelSummary(cancel), /세션 진행/);
  assert.match(await readFile(join(start.jobDir, "session_summary.md"), "utf8"), /사용자 요청으로 세션이 취소되었습니다/);
});

test("Codex job adaptive loop creates adaptive artifacts and Korean progress", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-adaptive-start-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    userRequest: "문서와 사용성 설명을 25분 예산으로 알아서 개선해. 먼저 가장 유용한 작은 개선을 하고, 결과를 보고 다음에 할 일을 스스로 골라서 이어서 처리해.",
    sessionMode: "adaptive_loop",
    timeBudgetMinutes: 25,
    maxSteps: 3,
    push: false,
    runTests: true,
    maxFixAttempts: 1,
    startWorker: false
  });

  assert.equal(start.sessionMode, "adaptive_loop");
  assert.equal(start.adaptiveMode, true);
  assert.equal(start.totalSteps, 3);
  assert.equal(start.currentAdaptiveStep, 0);
  assert.equal(Boolean(start.nextAction), true);
  assert.match(formatCodexJobStartSummary(start), /adaptive next-action loop/);

  const jobState = JSON.parse(await readFile(join(start.jobDir, "job.yaml"), "utf8"));
  assert.equal(jobState.session_mode, "adaptive_loop");
  assert.equal(jobState.adaptive_mode, true);
  assert.equal(jobState.step_review_mode, "heuristic");
  assert.equal(jobState.adaptive_state_path, join(start.jobDir, "adaptive_state.json"));
  assert.equal(jobState.adaptive_loop_path, join(start.jobDir, "adaptive_loop.md"));
  assert.equal(Boolean(jobState.next_action), true);
  assert.equal(jobState.stop_reason, null);
  assert.match(jobState.goal_progress_summary, /아직 완료된 adaptive step/);

  const adaptiveState = JSON.parse(await readFile(join(start.jobDir, "adaptive_state.json"), "utf8"));
  assert.equal(adaptiveState.mode, "adaptive_loop");
  assert.equal(adaptiveState.max_steps, 3);
  assert.equal(Boolean(adaptiveState.next_action), true);
  assert.match(await readFile(join(start.jobDir, "adaptive_loop.md"), "utf8"), /Adaptive Next-Action Loop/);
  assert.match(await readFile(join(start.jobDir, "next_action.md"), "utf8"), /Next Action/);
  assert.match(await readFile(join(start.jobDir, "updated_backlog.md"), "utf8"), /Updated Backlog/);

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(status.sessionMode, "adaptive_loop");
  assert.equal(status.adaptiveMode, true);
  assert.equal(status.currentAdaptiveStep, 0);
  assert.equal(Boolean(status.nextAction), true);
  assert.match(formatCodexJobStatusSummary(status), /adaptive next-action loop/);
  assert.match(formatCodexJobStatusSummary(status), /다음 예정 작업:/);

  const cancel = await cancelWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.sessionMode, "adaptive_loop");
  assert.equal(cancel.stopReason, "cancelled");
  assert.match(formatCodexJobCancelSummary(cancel), /adaptive next-action loop/);
  assert.match(formatCodexJobCancelSummary(cancel), /Adaptive artifacts:/);

  const cancelledAdaptiveState = JSON.parse(await readFile(join(start.jobDir, "adaptive_state.json"), "utf8"));
  assert.equal(cancelledAdaptiveState.stop_reason, "cancelled");
  assert.equal(cancelledAdaptiveState.next_action, null);
});

test("Codex job timeline and result report include durations and observability fields", () => {
  const state = {
    job_id: "JOB-0001",
    task_id: "TASK-0001",
    status: "completed",
    current_step: "completed",
    user_request: "Improve documentation.",
    branch: "codex/JOB-0001-improve-documentation",
    worktree: "/tmp/weaveflow-job/repo",
    job_dir: "/tmp/weaveflow-job",
    started_at: "2026-05-12T00:00:00.000Z",
    updated_at: "2026-05-12T00:00:12.000Z",
    finished_at: "2026-05-12T00:00:12.000Z",
    elapsed_ms: 12000,
    planning_elapsed_ms: 2000,
    codex_elapsed_ms: 5000,
    tests_elapsed_ms: 3000,
    commit_elapsed_ms: 1000,
    push_elapsed_ms: 1000,
    fix_attempts_elapsed_ms: 0,
    fix_attempts_used: 0,
    stage_timestamps: {
      job_created: "2026-05-12T00:00:00.000Z",
      planning_started: "2026-05-12T00:00:00.000Z",
      planning_finished: "2026-05-12T00:00:02.000Z",
      codex_started: "2026-05-12T00:00:02.000Z",
      codex_finished: "2026-05-12T00:00:07.000Z",
      tests_started: "2026-05-12T00:00:07.000Z",
      tests_finished: "2026-05-12T00:00:10.000Z",
      commit_started: "2026-05-12T00:00:10.000Z",
      commit_finished: "2026-05-12T00:00:11.000Z",
      push_started: "2026-05-12T00:00:11.000Z",
      push_finished: "2026-05-12T00:00:12.000Z",
      job_completed: "2026-05-12T00:00:12.000Z"
    },
    last_event: "job_completed",
    commit_hash: "abc1234",
    pushed: true,
    changed_files: ["docs/example.md"],
    tests: {
      run: true,
      passed: true,
      checks: [
        {
          name: "git diff --check",
          command: "git diff --check",
          passed: true
        }
      ]
    },
    outcome_contract_path: "/tmp/weaveflow-job/outcome_contract.md",
    change_review_path: "/tmp/weaveflow-job/change_review.md",
    quality_gate_path: "/tmp/weaveflow-job/quality_gate.md",
    quality_gate_decision_path: "/tmp/weaveflow-job/quality_gate_decision.md",
    quality_gate_decision: "accept",
    quality_score: 96,
    quality_issues: [],
    quality_review_status: "accept",
    quality_fix_attempts_used: 0,
    result_artifact_path: "/tmp/weaveflow-job/result.md",
    error: null
  };

  assert.deepEqual(jobStageDurations(state), {
    planning: 2000,
    codex: 5000,
    tests: 3000,
    fixes: 0,
    commit: 1000,
    push: 1000
  });
  const timeline = buildJobTimeline(state);
  assert.equal(timeline.some((row) => row.key === "planning" && row.durationMs === 2000), true);

  const result = renderCodexJobResultMarkdown(state, {
    selectedScopeMarkdown: "# Selected Scope\n\nImprove docs."
  });
  assert.match(result, /## Requested Goal/);
  assert.match(result, /## Timeline/);
  assert.match(result, /## Tests and Checks/);
  assert.match(result, /## Outcome Contract/);
  assert.match(result, /## Change Review/);
  assert.match(result, /## Quality Gate/);
  assert.match(result, /Quality score: 96/);
  assert.match(result, /Commit\/push proceeded because accepted: yes/);
  assert.match(result, /## Commit and Branch/);
  assert.match(result, /abc1234/);
});

test("smoke sequence works against a temporary Weaveflow workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-openclaw-test-"));
  await initializeWeaveflowWorkspace({ workspaceRoot });

  const summary = await runWeaveflowStdioPoc({
    workspaceRoot,
    taskText: "OpenClaw stdio bridge POC task from node test"
  });

  assert.equal(summary.ok, true, JSON.stringify(summary, null, 2));
  assert.equal(summary.pendingConfirmationSeen, true);
  assert.equal(summary.confirmationCompleted, true);
  assert.equal(summary.taskListSeen, true);
  assert.equal(summary.taskListIncludesCreatedTask, true);
  assert.equal(summary.shutdownSucceeded, true);
  assert.match(summary.taskId, /^TASK-\d{4}$/);
});

test("smoke sequence does not target the production Weaveflow workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-openclaw-test-"));
  await initializeWeaveflowWorkspace({ workspaceRoot });

  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  assert.notEqual(resolve(workspaceRoot), repoRoot);

  const summary = await runWeaveflowStdioPoc({ workspaceRoot });
  assert.equal(summary.ok, true, JSON.stringify(summary, null, 2));
  assert.match(resolve(workspaceRoot), /^\/tmp\//);
});

async function writeFakeCodexJob({ workspaceRoot, jobId, repoRoot, state = {}, result = "# Result\n\n대기\n" }) {
  const jobDir = join(workspaceRoot, ".weaveflow", "jobs", jobId);
  const now = "2026-05-12T11:00:00.000Z";
  await mkdir(jobDir, { recursive: true });
  const fullState = {
    job_id: jobId,
    task_id: jobId.replace("JOB", "TASK"),
    status: "running",
    current_step: "codex_exec",
    user_request: "Recover fake Codex job.",
    repo_root: repoRoot,
    branch: `codex/${jobId}-recovery`,
    worktree: `/tmp/weaveflow-${jobId}/repo`,
    started_at: now,
    updated_at: now,
    finished_at: null,
    elapsed_ms: 0,
    last_event: "codex_started",
    pushed: false,
    changed_files: [],
    tests: { run: true, passed: true, checks: [] },
    job_policy: {
      push: true,
      runTests: true,
      maxFixAttempts: 1,
      allowedActions: ["commit_changes", "push_branch"]
    },
    verification_plan: {
      mode: "fast",
      commands: [{ name: "git diff --check", command: "git diff --check", required: true }]
    },
    ...state
  };
  await writeFile(join(jobDir, "job.yaml"), `${JSON.stringify(fullState, null, 2)}\n`, "utf8");
  await writeFile(join(jobDir, "events.jsonl"), `${JSON.stringify({ timestamp: now, event: fullState.last_event, status: fullState.status })}\n`, "utf8");
  await writeFile(join(jobDir, "goal.md"), `# Goal\n\n${fullState.user_request}\n`, "utf8");
  await writeFile(join(jobDir, "selected_scope.md"), "# Selected Scope\n\n- fake recovery scope\n", "utf8");
  await writeFile(join(jobDir, "stdout.log"), "", "utf8");
  await writeFile(join(jobDir, "stderr.log"), "", "utf8");
  if (result !== null) {
    await writeFile(join(jobDir, "result.md"), result, "utf8");
  }
  return { jobDir, state: fullState };
}

function createRecoveryGitRunner(options = {}) {
  const worktreePath = options.worktreePath || "/tmp/nonexistent-worktree";
  const branch = options.branch || "codex/JOB-0091-stale";
  const head = options.head || "abc1234";
  const worktreeExists = options.worktreeExists === true;
  const branchExists = options.branchExists === true;
  const status = options.status || "";
  const runner = async (command, args) => {
    assert.equal(command, "git");
    runner.calls.push({ args });
    const serialized = JSON.stringify(args);
    if (serialized === JSON.stringify(["worktree", "list", "--porcelain"])) {
      return {
        code: 0,
        stdout: worktreeExists
          ? [`worktree ${worktreePath}`, `HEAD ${head}`, `branch refs/heads/${branch}`].join("\n")
          : "",
        stderr: "",
        termination: "exit"
      };
    }
    if (args.includes("show-ref")) {
      return {
        code: branchExists ? 0 : 1,
        stdout: branchExists ? `${head} refs/heads/${branch}\n` : "",
        stderr: "",
        termination: "exit"
      };
    }
    if (args.includes("status")) {
      return { code: 0, stdout: status, stderr: "", termination: "exit" };
    }
    if (args.includes("rev-parse")) {
      return { code: 0, stdout: `${head}\n`, stderr: "", termination: "exit" };
    }
    if (args.includes("diff") && args.includes("--stat")) {
      return { code: 0, stdout: status ? " README.md | 2 ++\n 1 file changed, 2 insertions(+)\n" : "", stderr: "", termination: "exit" };
    }
    if (args.includes("diff") && args.includes("--name-status")) {
      return { code: 0, stdout: status ? "M\tREADME.md\n" : "", stderr: "", termination: "exit" };
    }
    if (args.includes("ls-remote")) {
      return { code: 0, stdout: options.pushed ? `${head}\trefs/heads/${branch}\n` : "", stderr: "", termination: "exit" };
    }
    return { code: 0, stdout: "", stderr: "", termination: "exit" };
  };
  runner.calls = [];
  return runner;
}
