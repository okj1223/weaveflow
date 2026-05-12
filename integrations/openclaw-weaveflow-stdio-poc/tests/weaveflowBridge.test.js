import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CONTRACT_VERSION,
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
  formatCodexJobStartSummary,
  formatCodexJobStatusSummary,
  initializeWeaveflowWorkspace,
  isBroadAutonomousRequest,
  jobStageDurations,
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
  assert.equal(jobState.time_budget_minutes, 30);
  assert.equal(jobState.max_fix_attempts, 2);
  assert.equal(jobState.elapsed_ms >= 0, true);
  assert.equal(jobState.last_event, "outcome_contract_created");
  assert.equal(jobState.stage_timestamps.job_created.length > 0, true);
  assert.equal(jobState.outcome_contract_path, join(start.jobDir, "outcome_contract.md"));
  assert.equal(jobState.quality_review_status, "pending");
  assert.match(await readFile(join(start.jobDir, "outcome_contract.md"), "utf8"), /Outcome Contract/);
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
  assert.equal(status.repoResolution.repoAlias, "weaveflow");
  assert.equal(status.elapsedMs >= 0, true);
  assert.deepEqual(Object.keys(status.stageDurations), ["planning", "codex", "tests", "fixes", "commit", "push"]);
  assert.match(formatCodexJobStartSummary(start), /Weaveflow Codex 작업 시작/);
  assert.match(formatCodexJobStatusSummary(status), /Weaveflow Codex 작업 상태/);
  assert.match(formatCodexJobStatusSummary(status), /Codex 작업 정책/);
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
  assert.equal(cancelledState.elapsed_ms >= 0, true);
  assert.equal(cancelledState.stage_timestamps.job_cancelled.length > 0, true);
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
