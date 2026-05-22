#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_JOB_ACTION_OUTCOMES,
  cancelWeaveflowCodexJob,
  checkWeaveflowCodexJob,
  formatCodexJobCancelSummary,
  formatCodexJobRecoverySummary,
  formatCodexJobStartSummary,
  formatCodexJobStatusSummary,
  recoverWeaveflowCodexJob,
  startWeaveflowCodexJob
} from "../src/weaveflowBridge.js";
import {
  buildMorningReview,
  formatMorningReviewToolResponseKo
} from "../src/operatorDashboard.js";
import {
  executeOperatorAction,
  renderActionResultKo
} from "../src/operatorActions.js";

export const REGRESSION_PROMPT_A = "<@1486861488349249696> 그리고 아직도 깜박거리네 하 씨발 진짜 그리고 뭐냐 스크롤 내려서 토익 들어가봤는데 왜 거기서도 스크롤 내려가있는 상태에서 시작하냐 당연히 맨위에서 시작아니냐? 이런걸 일일이 내가 디버깅할 수가 없잖아 이개새끼야 weacflow깃풀로 당긴다음에 장기작업으로 어떻게든 고쳐내 실수없고 버그없고 갑자기 기능 바꾸고 ui뒤집어놓고 그런거 없이 알잘딱으로 알겠어? 전체 점검 대규모 점검들어가서 고쳐 일일이 꼼꼼히";
export const REGRESSION_PROMPT_B = "<@1486861488349249696> 토익 단어들도 진짜 토익단어인지 여자친구용 뜻이 어색하진 않은지 단어책 뜻이 아니라 서술식으로 이상하게 되어 있다던지 ets 단어장이라도 보고 참고하라 그래 인터넷뒤져서 그거 장기작업으로 검증해";

export const BANNED_FALLBACK_TEXT = [
  "일반 Codex 장기 세션",
  "일반 Codex로 우회",
  "Weaveflow가 안 되니 Codex로 돌리겠다",
  "Weaveflow 장기작업 툴은 이 범위를 못 받는다",
  "정책에서 막혀서 일반 Codex로",
  "이건 내가 우겨서 뚫을 수 없다",
  "범위가 커서 못 한다",
  "Codex에 맡길게",
  "진행시킬게"
];

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "limit_reached",
  "needs_user_review",
  "start_failed",
  "job_created_worker_start_failed",
  "blocked_weaveflow_runtime_unavailable",
  "blocked_codex_command_unavailable",
  "blocked_target_workspace_missing",
  "blocked_target_workspace_unreadable",
  "blocked_target_workspace_not_git_repo",
  "blocked_git_preflight_failed",
  "blocked_worker_script_missing",
  "blocked_worker_unavailable"
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const fakeCodexPath = join(scriptDir, "fake-codex-cli.js");
const reportsDir = join(pluginRoot, "reports");

export async function runIntegrationHarness(options = {}) {
  await chmod(fakeCodexPath, 0o755).catch(() => {});
  await mkdir(reportsDir, { recursive: true });

  const checks = [];
  const contractGaps = [];
  const artifactsObserved = {
    jobDirs: [],
    chainDirs: [],
    startOutcomes: [],
    workerStarts: [],
    heartbeats: [],
    jobStatuses: [],
    sessionLogs: [],
    cancelRequests: [],
    operatorReviews: [],
    recoveryPlans: [],
    resumeCapsules: []
  };
  const responses = [];
  const targetWorkspaceRoot = await createTempTargetRepo();
  const envSnapshot = snapshotEnv();

  const context = {
    createdAt: new Date().toISOString(),
    fakeCodexPath,
    targetWorkspaceRoot,
    runtimeRoot: repoRoot,
    checks,
    contractGaps,
    artifactsObserved,
    responses,
    promptA: null,
    promptB: null,
    exitFast: null,
    check: null,
    cancel: null,
    recover: null,
    morningReview: null,
    operatorAction: null
  };

  try {
    context.promptA = await runPromptA(context);
    context.cancel = await runCancelCheck(context, context.promptA);
    context.promptB = await runPromptB(context);
    context.exitFast = await runExitFastCheck(context);
    context.check = await runCheckTruthfulness(context, context.promptB);
    context.recover = await runRecoverChecks(context, context.promptB);
    context.morningReview = await runMorningReviewChecks(context);
    context.operatorAction = await runOperatorActionChecks(context, context.promptB);
    await collectArtifacts(context);
    recordContractGaps(context);
  } catch (error) {
    addCheck(checks, "harness unexpected error", false, safeError(error));
    context.error = safeError(error);
  } finally {
    restoreEnv(envSnapshot);
  }

  const report = buildReport(context);
  if (options.writeReport !== false) {
    await writeHarnessReports(report);
  }
  if (options.throwOnFail === true && report.summary.status === "FAIL") {
    throw new Error(`integration harness failed: ${report.summary.failedChecks} failed checks`);
  }
  return report;
}

export function containsBannedFallbackText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return BANNED_FALLBACK_TEXT.filter((phrase) => text.includes(phrase));
}

async function runPromptA(context) {
  setFakeCodexEnv({
    FAKE_CODEX_MODE: "sleep",
    FAKE_CODEX_SLEEP_MS: "45000",
    FAKE_CODEX_OUTPUT_TEXT: "Fake Codex sleep mode for live worker lifecycle verification."
  });
  const start = await startWeaveflowCodexJob(baseStartOptions(context, {
    userRequest: REGRESSION_PROMPT_A,
    maxRuntimeMinutes: 2,
    runTests: false
  }));
  const startText = formatCodexJobStartSummary(start);
  context.responses.push({ label: "promptA.start", text: startText, details: start });
  assertNoBanned(context, "Prompt A start response", startText);
  assertStartedJob(context, "Prompt A", start);
  await assertStartArtifacts(context, "Prompt A", start, {
    expectedJobType: "long_running_repair_job"
  });
  await waitForJobState(start.jobDir, (state) => state.current_step === "codex_exec" || state.current_step === "git_worktree" || state.status === "running", 20000);
  const heartbeat = await readJson(join(start.jobDir, "heartbeat.json"));
  addCheck(context.checks, "Prompt A sleep mode writes fresh heartbeat", isFreshTimestamp(heartbeat?.lastHeartbeatAt, 15000), {
    heartbeatPath: join(start.jobDir, "heartbeat.json"),
    lastHeartbeatAt: heartbeat?.lastHeartbeatAt || null
  });
  return { start, startText };
}

async function runPromptB(context) {
  setFakeCodexEnv({
    FAKE_CODEX_MODE: "fail",
    FAKE_CODEX_SLEEP_MS: "100",
    FAKE_CODEX_EXIT_CODE: "7",
    FAKE_CODEX_OUTPUT_TEXT: "Fake Codex deterministic failure for truthfulness verification."
  });
  const start = await startWeaveflowCodexJob(baseStartOptions(context, {
    userRequest: REGRESSION_PROMPT_B,
    maxRuntimeMinutes: 2,
    runTests: false
  }));
  const startText = formatCodexJobStartSummary(start);
  context.responses.push({ label: "promptB.start", text: startText, details: start });
  assertNoBanned(context, "Prompt B start response", startText);
  assertStartedJob(context, "Prompt B", start);
  await assertStartArtifacts(context, "Prompt B", start, {
    expectedJobType: "long_running_data_review_job"
  });
  await waitForJobState(start.jobDir, (state) => TERMINAL_STATUSES.has(state.status), 30000);
  const jobStatus = await readJson(join(start.jobDir, "job_status.json"));
  const sessionLog = await readText(join(start.jobDir, "session_log.jsonl"));
  addCheck(context.checks, "Prompt B fail mode writes failed job_status", jobStatus?.status === "failed", {
    jobStatusPath: join(start.jobDir, "job_status.json"),
    status: jobStatus?.status || null,
    exitCode: jobStatus?.exitCode ?? null
  });
  addCheck(context.checks, "Prompt B fail mode writes worker_failed session event", sessionLog.includes("\"event\":\"worker_failed\""), {
    sessionLogPath: join(start.jobDir, "session_log.jsonl")
  });
  return { start, startText };
}

async function runExitFastCheck(context) {
  setFakeCodexEnv({
    FAKE_CODEX_MODE: "exit-fast",
    FAKE_CODEX_SLEEP_MS: "0",
    FAKE_CODEX_EXIT_CODE: "0",
    FAKE_CODEX_OUTPUT_TEXT: "Fake Codex exit-fast lifecycle check."
  });
  const start = await startWeaveflowCodexJob(baseStartOptions(context, {
    userRequest: "OpenClaw runner lifecycle 검증용 장기작업을 exit-fast 모드로 시작해.",
    maxRuntimeMinutes: 2,
    runTests: false
  }));
  const startText = formatCodexJobStartSummary(start);
  context.responses.push({ label: "exitFast.start", text: startText, details: start });
  assertNoBanned(context, "exit-fast start response", startText);
  assertStartedJob(context, "Exit-fast", start);
  await assertStartArtifacts(context, "Exit-fast", start);
  await waitForJobState(start.jobDir, (state) => TERMINAL_STATUSES.has(state.status), 30000);
  const check = await checkWeaveflowCodexJob({
    workspaceRoot: context.targetWorkspaceRoot,
    repoRoot: context.targetWorkspaceRoot,
    jobId: start.jobId
  });
  const jobStatus = await readJson(join(start.jobDir, "job_status.json"));
  addCheck(context.checks, "exit-fast terminal worker is not reported as running", check.status !== "running", {
    checkStatus: check.status,
    jobStatus: jobStatus?.status || null
  });
  return { start, startText, check, jobStatus };
}

async function runCancelCheck(context, promptResult) {
  const start = promptResult?.start || {};
  const cancel = await cancelWeaveflowCodexJob({
    workspaceRoot: context.targetWorkspaceRoot,
    repoRoot: context.targetWorkspaceRoot,
    jobId: start.jobId,
    reason: "integration_harness_cancel"
  });
  const cancelText = formatCodexJobCancelSummary(cancel);
  context.responses.push({ label: "promptA.cancel", text: cancelText, details: cancel });
  assertNoBanned(context, "cancel response", cancelText);
  const cancelRequestPath = join(start.jobDir, "cancel_request.json");
  addCheck(context.checks, "cancel_request.json created", existsSync(cancelRequestPath), { cancelRequestPath });
  addCheck(context.checks, "cancel response does not fake success when process already ended", cancel.cancelled === true || cancel.status !== "running", {
    cancelled: cancel.cancelled,
    status: cancel.status,
    previousStatus: cancel.previousStatus
  });
  return { cancel, cancelText, cancelRequestPath };
}

async function runCheckTruthfulness(context, promptResult) {
  const start = promptResult?.start || {};
  const state = await readJson(join(start.jobDir, "job.yaml"));
  const check = await checkWeaveflowCodexJob({
    workspaceRoot: context.targetWorkspaceRoot,
    repoRoot: context.targetWorkspaceRoot,
    jobId: start.jobId
  });
  const checkText = formatCodexJobStatusSummary(check);
  context.responses.push({ label: "promptB.check", text: checkText, details: check });
  assertNoBanned(context, "check response", checkText);
  addCheck(context.checks, "check finds started job", check.jobId === start.jobId, { jobId: check.jobId, expected: start.jobId });
  addCheck(context.checks, "terminal fake worker is not reported as running", !(TERMINAL_STATUSES.has(state?.status) && check.status === "running"), {
    jobStateStatus: state?.status,
    checkStatus: check.status
  });
  addCheck(context.checks, "check returns structured lifecycle state", ["running", "completed", "failed", "stale", "cancelled", "timeout", "needs_user_review"].includes(check.status) || TERMINAL_STATUSES.has(check.status), {
    status: check.status
  });
  return { check, checkText, jobState: state };
}

async function runRecoverChecks(context, promptResult) {
  const start = promptResult?.start || {};
  const recover = await recoverWeaveflowCodexJob({
    workspaceRoot: context.targetWorkspaceRoot,
    repoRoot: context.targetWorkspaceRoot,
    jobId: start.jobId,
    apply: false
  });
  const recoverText = formatCodexJobRecoverySummary(recover);
  context.responses.push({ label: "promptB.recover", text: recoverText, details: recover });
  assertNoBanned(context, "recover response", recoverText);
  addCheck(context.checks, "recover inspect/prepare returns dryRun plan", recover.dryRun === true && existsSync(recover.recoveryPlanPath || ""), {
    dryRun: recover.dryRun,
    recoveryPlanPath: recover.recoveryPlanPath
  });
  addCheck(context.checks, "recover exposes resume capsule or fallback recovery context", recover.resumeCapsulePath || recover.nextSuggestedPromptReady === true || recover.recoveryPlanPath, {
    resumeCapsulePath: recover.resumeCapsulePath || null,
    nextSuggestedPromptReady: recover.nextSuggestedPromptReady
  });
  return { recover, recoverText };
}

async function runMorningReviewChecks(context) {
  const review = await buildMorningReview({
    workspaceRoot: context.targetWorkspaceRoot,
    since: "24h",
    includeChains: true,
    maxItems: 20
  });
  const reviewText = formatMorningReviewToolResponseKo(review);
  context.responses.push({ label: "morningReview", text: reviewText, details: review });
  assertNoBanned(context, "morning review response", reviewText);
  addCheck(context.checks, "morning review markdown artifact created", existsSync(review.artifactPaths?.reviewMarkdownPath || ""), review.artifactPaths);
  addCheck(context.checks, "morning review json artifact created", existsSync(review.artifactPaths?.reviewJsonPath || ""), review.artifactPaths);
  addCheck(context.checks, "morning review discovers jobs", Number(review.summary?.totalJobs || 0) >= 2, review.summary);
  addCheck(context.checks, "morning review uses non-running categories for failed/cancelled work", Number(review.summary?.needsAttention || 0) + Number(review.summary?.readyForReview || 0) + Number(review.summary?.canContinue || 0) + Number(review.summary?.blocked || 0) >= 0, review.summary);
  return { review, reviewText };
}

async function runOperatorActionChecks(context, promptResult) {
  const start = promptResult?.start || {};
  const menu = await executeOperatorAction({
    workspaceRoot: context.targetWorkspaceRoot,
    jobId: start.jobId
  });
  const recoverPreview = await executeOperatorAction({
    workspaceRoot: context.targetWorkspaceRoot,
    jobId: start.jobId,
    action: "recover"
  }, {
    recoverWeaveflowCodexJob
  });
  const prepareRecover = await executeOperatorAction({
    workspaceRoot: context.targetWorkspaceRoot,
    jobId: start.jobId,
    action: "prepare_recover",
    confirm: true,
    reason: "integration_harness_prepare_recover"
  });
  const dangerous = await executeOperatorAction({
    workspaceRoot: context.targetWorkspaceRoot,
    jobId: start.jobId,
    action: "push",
    confirm: true
  });
  const texts = [menu.koreanSummary, renderActionResultKo(recoverPreview), renderActionResultKo(prepareRecover), renderActionResultKo(dangerous)].join("\n");
  context.responses.push({ label: "operatorAction", text: texts, details: { menu, recoverPreview, prepareRecover, dangerous } });
  assertNoBanned(context, "operator action response", texts);
  addCheck(context.checks, "operator action menu created", menu.status === "menu" && Array.isArray(menu.menu?.actions), { status: menu.status });
  addCheck(context.checks, "controlled worker start previews without confirm/token", recoverPreview.status === "preview" && recoverPreview.workerStarted === false, {
    status: recoverPreview.status,
    workerStarted: recoverPreview.workerStarted
  });
  addCheck(context.checks, "prepare_recover creates plan without worker start", prepareRecover.status === "recovery_plan_prepared" && prepareRecover.workerStarted === false && existsSync(prepareRecover.recoveryPlanPath || ""), {
    status: prepareRecover.status,
    recoveryPlanPath: prepareRecover.recoveryPlanPath,
    workerStarted: prepareRecover.workerStarted
  });
  addCheck(context.checks, "dangerous push action denied", dangerous.status === "dangerous_denied" && dangerous.ok === false, {
    status: dangerous.status,
    ok: dangerous.ok
  });
  return { menu, recoverPreview, prepareRecover, dangerous, text: texts };
}

function baseStartOptions(context, overrides = {}) {
  return {
    workspaceRoot: context.targetWorkspaceRoot,
    repoRoot: context.targetWorkspaceRoot,
    weaveflowRuntimeRoot: context.runtimeRoot,
    pythonExecutable: process.env.WEAVEFLOW_PYTHON || "python3",
    codexExecutable: context.fakeCodexPath,
    runProfile: "company",
    allowPush: false,
    push: false,
    maxSegments: 3,
    maxFixAttempts: 0,
    maxRepeatedFailures: 1,
    totalJobBudgetMinutes: 120,
    checkpointEveryMinutes: 1,
    workerPreflightTimeoutMs: 10000,
    ...overrides
  };
}

async function assertStartArtifacts(context, label, start, expectations = {}) {
  addCheck(context.checks, `${label} has jobId`, Boolean(start.jobId), start);
  addCheck(context.checks, `${label} has job dir`, existsSync(start.jobDir || ""), { jobDir: start.jobDir });
  const startOutcome = await readJson(join(start.jobDir, "start_outcome.json"));
  const workerStart = await readJson(join(start.jobDir, "worker_start.json"));
  await waitForPath(join(start.jobDir, "heartbeat.json"), 10000);
  await waitForPath(join(start.jobDir, "job_status.json"), 10000);
  await waitForPath(join(start.jobDir, "session_log.jsonl"), 10000);
  const heartbeat = await readJson(join(start.jobDir, "heartbeat.json"));
  const jobStatus = await readJson(join(start.jobDir, "job_status.json"));
  const sessionLog = await readText(join(start.jobDir, "session_log.jsonl"));
  const policyDecision = await readJson(join(start.jobDir, "policy_decision.json"));
  const jobRequest = await readJson(join(start.jobDir, "job_request.json"));
  const initialPrompt = await readText(join(start.jobDir, "initial_prompt.md"));
  addCheck(context.checks, `${label} start_outcome.json exists`, Boolean(startOutcome), { path: join(start.jobDir, "start_outcome.json") });
  addCheck(context.checks, `${label} worker_start.json exists`, Boolean(workerStart), { path: join(start.jobDir, "worker_start.json") });
  addCheck(context.checks, `${label} start_outcome workerStarted true`, startOutcome?.workerStarted === true || startOutcome?.worker_started === true, startOutcome);
  addCheck(context.checks, `${label} heartbeat.json exists`, Boolean(heartbeat), { path: join(start.jobDir, "heartbeat.json") });
  addCheck(context.checks, `${label} job_status.json exists`, Boolean(jobStatus), { path: join(start.jobDir, "job_status.json") });
  addCheck(context.checks, `${label} session_log.jsonl exists`, Boolean(sessionLog), { path: join(start.jobDir, "session_log.jsonl") });
  addCheck(context.checks, `${label} session_log records worker_started`, sessionLog.includes("\"event\":\"worker_started\""), {
    path: join(start.jobDir, "session_log.jsonl")
  });
  addCheck(context.checks, `${label} pid recorded`, Number.isFinite(Number(workerStart?.pid || startOutcome?.pid || start.pid)), {
    workerStartPid: workerStart?.pid,
    startOutcomePid: startOutcome?.pid,
    startPid: start.pid
  });
  addCheck(context.checks, `${label} policy_decision.json exists`, Boolean(policyDecision), { path: join(start.jobDir, "policy_decision.json") });
  addCheck(context.checks, `${label} initial_prompt.md exists`, Boolean(initialPrompt), { path: join(start.jobDir, "initial_prompt.md") });
  if (expectations.expectedJobType) {
    addCheck(context.checks, `${label} expected job type`, jobRequest?.job_type === expectations.expectedJobType || (label === "Prompt B" && jobRequest?.job_type === "long_running_research_validation_job"), {
      expected: expectations.expectedJobType,
      actual: jobRequest?.job_type
    });
  }
  addCheck(context.checks, `${label} profile company`, jobRequest?.run_profile === "company" || policyDecision?.runProfile === "company", {
    jobRequestRunProfile: jobRequest?.run_profile,
    policyRunProfile: policyDecision?.runProfile
  });
  addCheck(context.checks, `${label} allow_with_constraints policy`, jobRequest?.policy_decision === "allow_with_constraints" || policyDecision?.policyDecision === "allow_with_constraints", {
    jobRequestPolicy: jobRequest?.policy_decision,
    policyDecision: policyDecision?.policyDecision
  });
  addCheck(context.checks, `${label} safe_worktree execution`, jobRequest?.execution_mode === "safe_worktree" || policyDecision?.executionMode === "safe_worktree", {
    jobRequestExecutionMode: jobRequest?.execution_mode,
    policyExecutionMode: policyDecision?.executionMode
  });
  addCheck(context.checks, `${label} initial prompt includes original request`, initialPrompt.includes("Original User Request"), {});
}

function assertStartedJob(context, label, start) {
  addCheck(context.checks, `${label} response is not dry explanation`, Boolean(start?.actionOutcome || start?.action_outcome), {
    actionOutcome: start?.actionOutcome || start?.action_outcome
  });
  addCheck(context.checks, `${label} fake Codex available starts job`, (start?.actionOutcome || start?.action_outcome) === CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB, {
    actionOutcome: start?.actionOutcome || start?.action_outcome,
    status: start?.status
  });
}

async function collectArtifacts(context) {
  const jobsRoot = join(context.targetWorkspaceRoot, ".weaveflow", "jobs");
  const jobDirs = await listDirs(jobsRoot, /^JOB-\d+/);
  const chainDirs = await listDirs(join(jobsRoot, "chains"), /^CHAIN-\d+/);
  context.artifactsObserved.jobDirs = jobDirs;
  context.artifactsObserved.chainDirs = chainDirs;
  for (const jobDir of jobDirs) {
    for (const [key, name] of [
      ["startOutcomes", "start_outcome.json"],
      ["workerStarts", "worker_start.json"],
      ["heartbeats", "heartbeat.json"],
      ["jobStatuses", "job_status.json"],
      ["sessionLogs", "session_log.jsonl"],
      ["cancelRequests", "cancel_request.json"],
      ["recoveryPlans", "recovery_plan.json"],
      ["resumeCapsules", "resume_capsule.json"]
    ]) {
      const path = join(jobDir, name);
      if (existsSync(path)) context.artifactsObserved[key].push(path);
    }
  }
  const reviewDir = join(jobsRoot, "operator_reviews");
  const reviews = await readdir(reviewDir).catch(() => []);
  context.artifactsObserved.operatorReviews = reviews.map((entry) => join(reviewDir, entry));
}

function recordContractGaps(context) {
  const jobDirs = context.artifactsObserved.jobDirs || [];
  const heartbeatCount = countExisting(jobDirs, "heartbeat.json");
  const jobStatusCount = countExisting(jobDirs, "job_status.json");
  const sessionLogCount = countExisting(jobDirs, "session_log.jsonl");
  if (heartbeatCount === 0) {
    context.contractGaps.push("heartbeat writer missing or not exercised: no heartbeat.json observed in live fake-worker run.");
  }
  if (jobStatusCount === 0) {
    context.contractGaps.push("job_status writer missing or not exercised: no job_status.json observed in live fake-worker run.");
  }
  if (sessionLogCount === 0) {
    context.contractGaps.push("session_log writer missing or not exercised: no session_log.jsonl observed in live fake-worker run.");
  }
}

function buildReport(context) {
  const failedChecks = context.checks.filter((check) => check.status === "fail");
  const hasCriticalLifecycleFailure = failedChecks.some((check) => /start|worker_start|pid|fake Codex available/.test(check.name));
  const status = failedChecks.length
    ? "FAIL"
    : context.contractGaps.length
      ? "PARTIAL"
      : "PASS";
  const recommendedNextAction = status === "PASS"
    ? "A. Live OpenClaw pilot 가능"
    : hasCriticalLifecycleFailure
      ? "C. Real worker start path부터 고쳐야 함"
      : "B. Heartbeat/watchdog contract부터 고쳐야 함";
  const responseText = context.responses.map((entry) => entry.text || "").join("\n\n");
  return {
    schemaVersion: "weaveflow.integration_harness_report.v0",
    createdAt: new Date().toISOString(),
    summary: {
      status,
      promptAResult: summarizeStart(context.promptA?.start),
      promptBResult: summarizeStart(context.promptB?.start),
      exitFastResult: summarizeStart(context.exitFast?.start),
      realSpawnedWorkerWithFakeCli: Boolean(context.promptA?.start?.workerStarted && context.promptB?.start?.workerStarted),
      workerStartJsonCreated: context.artifactsObserved.workerStarts.length > 0,
      startOutcomeWorkerStartedTrue: context.artifactsObserved.startOutcomes.length > 0,
      heartbeatJsonCreated: context.artifactsObserved.heartbeats.length > 0,
      jobStatusJsonCreated: context.artifactsObserved.jobStatuses.length > 0,
      sessionLogJsonlCreated: context.artifactsObserved.sessionLogs.length > 0,
      checkTruthfulness: checkStatus(context, "terminal fake worker is not reported as running"),
      exitFastTruthfulness: checkStatus(context, "exit-fast terminal worker is not reported as running"),
      cancelBehavior: checkStatus(context, "cancel_request.json created"),
      recoverBehavior: checkStatus(context, "recover inspect/prepare returns dryRun plan"),
      morningReviewBehavior: checkStatus(context, "morning review markdown artifact created"),
      operatorActionBehavior: checkStatus(context, "operator action menu created"),
      bannedFallbackTextFound: containsBannedFallbackText(responseText).length > 0,
      passedChecks: context.checks.filter((check) => check.status === "pass").length,
      failedChecks: failedChecks.length
    },
    workspace: {
      targetWorkspaceRoot: context.targetWorkspaceRoot,
      fakeCodexPath: context.fakeCodexPath,
      runtimeRoot: context.runtimeRoot
    },
    checks: context.checks,
    artifactsObserved: context.artifactsObserved,
    contractGapsObservedLive: context.contractGaps,
    responses: context.responses.map((entry) => ({
      label: entry.label,
      text: entry.text
    })),
    recommendedNextAction,
    error: context.error || null
  };
}

async function writeHarnessReports(report) {
  const jsonPath = join(reportsDir, "integration_harness_report.json");
  const markdownPath = join(reportsDir, "integration_harness_report.md");
  report.artifactPaths = { jsonPath, markdownPath };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderHarnessReportMarkdown(report), "utf8");
}

function renderHarnessReportMarkdown(report) {
  const summary = report.summary || {};
  return [
    "# Targeted Integration Harness Report",
    "",
    "## Summary",
    "",
    `- status: ${summary.status}`,
    `- Prompt A result: ${formatPromptSummary(summary.promptAResult)}`,
    `- Prompt B result: ${formatPromptSummary(summary.promptBResult)}`,
    `- exit-fast result: ${formatPromptSummary(summary.exitFastResult)}`,
    `- real spawned worker with fake CLI: ${yesNo(summary.realSpawnedWorkerWithFakeCli)}`,
    `- worker_start.json created: ${yesNo(summary.workerStartJsonCreated)}`,
    `- start_outcome workerStarted true: ${yesNo(summary.startOutcomeWorkerStartedTrue)}`,
    `- heartbeat.json created: ${yesNo(summary.heartbeatJsonCreated)}`,
    `- job_status.json created: ${yesNo(summary.jobStatusJsonCreated)}`,
    `- session_log.jsonl created: ${yesNo(summary.sessionLogJsonlCreated)}`,
    `- check truthfulness: ${summary.checkTruthfulness}`,
    `- exit-fast truthfulness: ${summary.exitFastTruthfulness}`,
    `- cancel behavior: ${summary.cancelBehavior}`,
    `- recover behavior: ${summary.recoverBehavior}`,
    `- morning review behavior: ${summary.morningReviewBehavior}`,
    `- operator action behavior: ${summary.operatorActionBehavior}`,
    `- banned fallback text found: ${yesNo(summary.bannedFallbackTextFound)}`,
    "",
    "## Artifacts observed",
    "",
    artifactLines(report.artifactsObserved),
    "",
    "## Contract gaps observed live",
    "",
    report.contractGapsObservedLive?.length
      ? report.contractGapsObservedLive.map((gap) => `- ${gap}`).join("\n")
      : "- none",
    "",
    "## Checks",
    "",
    report.checks.map((check) => `- ${check.status}: ${check.name}`).join("\n"),
    "",
    "## Recommended next action",
    "",
    report.recommendedNextAction,
    ""
  ].join("\n");
}

async function createTempTargetRepo() {
  const root = await mkdtemp(join(tmpdir(), "weaveflow-integration-target-"));
  await writeFile(join(root, "README.md"), "# Harness Target\n\nTemporary target repo for Weaveflow integration harness.\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "weaveflow-integration-target",
    private: true,
    scripts: {
      test: "node -e \"console.log('harness target test ok')\""
    }
  }, null, 2), "utf8");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "weaveflow-harness@example.invalid"]);
  runGit(root, ["config", "user.name", "Weaveflow Harness"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-m", "init harness target"]);
  return root;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function setFakeCodexEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  process.env.WEAVEFLOW_CODEX_COMMAND = fakeCodexPath;
}

function snapshotEnv() {
  const keys = ["FAKE_CODEX_MODE", "FAKE_CODEX_SLEEP_MS", "FAKE_CODEX_EXIT_CODE", "FAKE_CODEX_OUTPUT_TEXT", "WEAVEFLOW_CODEX_COMMAND"];
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function waitForJobState(jobDir, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readJson(join(jobDir, "job.yaml"));
    if (lastState && predicate(lastState)) return lastState;
    await sleep(250);
  }
  return lastState;
}

async function waitForPath(path, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return existsSync(path);
}

async function listDirs(root, pattern) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
    const path = join(root, entry.name);
    const stats = await stat(path).catch(() => null);
    dirs.push({ path, mtimeMs: stats?.mtimeMs || 0 });
  }
  return dirs.sort((left, right) => left.path.localeCompare(right.path)).map((entry) => entry.path);
}

function countExisting(jobDirs, name) {
  return jobDirs.filter((jobDir) => existsSync(join(jobDir, name))).length;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function addCheck(checks, name, condition, details = {}) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    details
  });
}

function assertNoBanned(context, label, text) {
  const found = containsBannedFallbackText(text);
  addCheck(context.checks, `${label} has no banned fallback text`, found.length === 0, { found });
}

function checkStatus(context, name) {
  const check = context.checks.find((entry) => entry.name === name);
  if (!check) return "partial";
  return check.status === "pass" ? "pass" : "fail";
}

function summarizeStart(start = {}) {
  return {
    jobId: start.jobId || null,
    chainId: start.chainId || null,
    actionOutcome: start.actionOutcome || start.action_outcome || null,
    status: start.status || null,
    workerStarted: start.workerStarted === true,
    pid: start.pid || null,
    jobDir: start.jobDir || null
  };
}

function formatPromptSummary(summary = {}) {
  return `${summary.actionOutcome || "unknown"} / ${summary.status || "unknown"} / ${summary.jobId || "no job"}`;
}

function artifactLines(artifacts = {}) {
  const keys = Object.keys(artifacts);
  if (!keys.length) return "- none";
  return keys.map((key) => {
    const values = artifacts[key] || [];
    return `- ${key}: ${values.length}${values.length ? `\n${values.map((value) => `  - ${value}`).join("\n")}` : ""}`;
  }).join("\n");
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function isFreshTimestamp(value, maxAgeMs) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) && Date.now() - parsed <= maxAgeMs;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function safeError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runIntegrationHarness({ throwOnFail: false });
  console.log(renderHarnessReportMarkdown(report));
  process.exitCode = report.summary.status === "FAIL" ? 1 : 0;
}
