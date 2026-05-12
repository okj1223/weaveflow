import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CONTRACT_VERSION,
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
      testCommands: ["git diff --check"]
    }
  });

  assert.equal(planning.resolvedMode, "timeboxed");
  assert.match(planning.backlogMarkdown, /Opportunity Backlog/);
  assert.match(planning.selectedScopeMarkdown, /Selected Scope/);
  assert.match(planning.executionPlanMarkdown, /Execution Plan/);
});

test("Codex job start creates file-based state without starting worker when requested", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "weaveflow-job-runner-test-"));
  const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const start = await startWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
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
  assert.equal(jobState.time_budget_minutes, 30);
  assert.equal(jobState.max_fix_attempts, 2);

  const status = await checkWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(status.status, "queued");
  assert.match(formatCodexJobStartSummary(start), /Weaveflow Codex 작업을 시작했습니다/);
  assert.match(formatCodexJobStatusSummary(status), /작업 ID:/);

  const cancel = await cancelWeaveflowCodexJob({
    workspaceRoot,
    repoRoot,
    jobId: start.jobId
  });
  assert.equal(cancel.cancelled, true);
  assert.match(formatCodexJobCancelSummary(cancel), /취소 처리: 예/);
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
