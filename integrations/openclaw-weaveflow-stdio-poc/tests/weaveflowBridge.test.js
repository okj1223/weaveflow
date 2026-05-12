import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CONTRACT_VERSION,
  buildJobTimeline,
  buildJobPlanningArtifacts,
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
  assert.equal(jobState.last_event, "job_created");
  assert.equal(jobState.stage_timestamps.job_created.length > 0, true);

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
