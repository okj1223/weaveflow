import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_JOB_ACTION_OUTCOMES,
  checkWeaveflowCodexJob,
  formatCodexJobStartSummary,
  formatPocSummary,
  initializeWeaveflowWorkspace,
  recoverWeaveflowCodexJob,
  runWeaveflowStdioPoc,
  startWeaveflowCodexJob
} from "../src/weaveflowBridge.js";
import {
  buildContinuationContext,
  buildContinuationDecision
} from "../src/continuationPlanner.js";
import {
  buildMorningReview,
  formatMorningReviewToolResponseKo
} from "../src/operatorDashboard.js";
import {
  buildActionToken,
  buildOperatorActionMenu,
  executeOperatorAction,
  renderActionResultKo
} from "../src/operatorActions.js";
import { writeJsonAtomic } from "../src/jobArtifacts.js";
import {
  buildBridgeCommand,
  defaultPluginDir,
  diagnoseWeaveflowRuntime,
  resolveWeaveflowRuntimeRoot,
  validateWeaveflowRuntime
} from "../src/weaveflowRuntime.js";

const providedRoot = process.env.WEAVEFLOW_POC_WORKSPACE_ROOT;
const pythonCommand = process.env.WEAVEFLOW_POC_PYTHON || "python3";
const workspaceRoot = providedRoot || await mkdtemp(join(tmpdir(), "weaveflow-openclaw-poc-"));
const targetRepoRoot = providedRoot || await mkdtemp(join(tmpdir(), "weaveflow-openclaw-target-repo-"));
if (!providedRoot) {
  execFileSync("git", ["init"], { cwd: targetRepoRoot, stdio: "ignore" });
  await writeFile(join(targetRepoRoot, "README.md"), "# Weaveflow OpenClaw target\n", "utf8");
}
const pluginRuntimeResolution = resolveWeaveflowRuntimeRoot({
  env: {},
  pluginDir: defaultPluginDir()
});

if (!pluginRuntimeResolution.ok) {
  console.error(JSON.stringify(pluginRuntimeResolution, null, 2));
  process.exit(1);
}

const runtime = await validateWeaveflowRuntime({
  targetWorkspaceRoot: workspaceRoot,
  pythonExecutable: process.env.WEAVEFLOW_POC_PYTHON,
  env: process.env
});

if (runtime.importOk !== true) {
  console.error(JSON.stringify(runtime, null, 2));
  process.exit(1);
}

const bridgeCommand = buildBridgeCommand({
  targetWorkspaceRoot: workspaceRoot,
  runtimeRoot: runtime.runtimeRoot,
  pythonExecutable: runtime.pythonExecutable,
  env: runtime.env
});
const doctor = await diagnoseWeaveflowRuntime({
  targetWorkspaceRoot: workspaceRoot,
  pythonExecutable: process.env.WEAVEFLOW_POC_PYTHON,
  env: process.env
});

if (bridgeCommand.runtimeRoot === bridgeCommand.targetWorkspaceRoot) {
  console.error("runtimeRoot and targetWorkspaceRoot must be tracked separately.");
  process.exit(1);
}

if (!providedRoot) {
  await initializeWeaveflowWorkspace({ workspaceRoot, pythonCommand });
}

const okWorkerPreflight = async (input) => ({
  ok: true,
  status: "ok",
  targetWorkspaceRoot: input.targetWorkspaceRoot,
  runtimeRoot: input.runtimeRoot,
  codexCommand: "codex",
  codexCommandAvailable: true,
  codexCommandStatus: "unknown_but_configured",
  workerScriptPath: input.workerScriptPath,
  workerStartCommand: {
    command: "node",
    args: [input.workerScriptPath, "--job-id", input.jobId],
    preview: `node ${input.workerScriptPath} --job-id ${input.jobId}`
  },
  gitPreflight: {
    status: "clean",
    pullRequested: true,
    pullMode: "ff-only"
  },
  checkedAt: new Date().toISOString()
});

const summary = await runWeaveflowStdioPoc({ workspaceRoot, pythonCommand });
const jobStart = await startWeaveflowCodexJob({
  workspaceRoot: targetRepoRoot,
  repoRoot: targetRepoRoot,
  userRequest: "회사에 있는 동안 깜박임과 스크롤 위치 버그를 장기작업으로 점검하고 고쳐줘.",
  push: false,
  runWorkerPreflight: okWorkerPreflight,
  startWorkerProcess: async () => ({ pid: process.pid })
});
const jobStartText = formatCodexJobStartSummary(jobStart);
const jobCheck = await checkWeaveflowCodexJob({
  workspaceRoot: targetRepoRoot,
  repoRoot: targetRepoRoot,
  jobId: jobStart.jobId
});
const recoveryPreview = await recoverWeaveflowCodexJob({
  workspaceRoot: targetRepoRoot,
  repoRoot: targetRepoRoot,
  jobId: jobStart.jobId,
  recoveryMode: "prepare_next_prompt"
});
const nextSegment = await recoverWeaveflowCodexJob({
  workspaceRoot: targetRepoRoot,
  repoRoot: targetRepoRoot,
  jobId: jobStart.jobId,
  recoveryMode: "start_next_segment",
  runWorkerPreflight: okWorkerPreflight,
  startWorkerProcess: async () => ({ pid: process.pid })
});
const usageLimitDecision = buildContinuationDecision(buildContinuationContext({
  jobState: {
    job_id: jobStart.jobId,
    chain_id: jobStart.chainId,
    run_profile: "company",
    continuation_mode: "auto_after_clean_segment",
    segment_index: 1,
    max_segments: 6,
    total_job_budget_minutes: 240,
    chain_consumed_budget_minutes: 45,
    stop_reason: "usage_limit_detected",
    limit_recovery_mode: "retry_later_manual"
  },
  resumeCapsule: {
    resume_capsule_path: jobStart.resumeCapsulePath,
    next_suggested_prompt: "Continue after the usage limit resets."
  }
}));
const resumeCapsuleExists = Boolean(await readFile(jobStart.resumeCapsulePath, "utf8").catch(() => ""));
const now = new Date().toISOString();
const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
await writeSmokeJob(targetRepoRoot, "JOB-0901", {
  job_id: "JOB-0901",
  status: "completed",
  current_step: "completed",
  commit_hash: "smoke123",
  updated_at: now,
  run_profile: "focused",
  tests: { passed: true, checks: [{ name: "smoke-check" }] },
  changed_files: ["README.md"]
}, { result: "# Result\n\nSmoke completed job.\n" });
await writeSmokeJob(targetRepoRoot, "JOB-0902", {
  job_id: "JOB-0902",
  status: CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
  action_outcome: CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
  current_step: CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
  updated_at: now,
  run_profile: "company"
});
await writeSmokeJob(targetRepoRoot, "JOB-0903", {
  job_id: "JOB-0903",
  status: "running",
  current_step: "verification_pass",
  pid: 999999,
  updated_at: staleTime,
  run_profile: "company"
});
const morningReview = await buildMorningReview({
  workspaceRoot: targetRepoRoot,
  since: "24h",
  now,
  processChecker: async (pid) => Number(pid) === process.pid
});
const morningReviewText = formatMorningReviewToolResponseKo(morningReview);
const morningReviewMarkdownExists = Boolean(await readFile(morningReview.artifactPaths.reviewMarkdownPath, "utf8").catch(() => ""));
const morningReviewJsonExists = Boolean(await readFile(morningReview.artifactPaths.reviewJsonPath, "utf8").catch(() => ""));
const actionMenu = await buildOperatorActionMenu({
  workspaceRoot: targetRepoRoot,
  jobId: jobStart.jobId
});
const prepareRecoverAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "prepare_recover",
  jobId: jobStart.jobId,
  confirm: true
}, {
  workspaceRoot: targetRepoRoot
});
const recoverPreviewAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "recover",
  jobId: jobStart.jobId
}, {
  workspaceRoot: targetRepoRoot,
  recoverWeaveflowCodexJob
});
const recoverActionToken = await buildActionToken("recover", {
  workspaceRoot: targetRepoRoot,
  jobId: jobStart.jobId
});
const recoverAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "recover",
  jobId: jobStart.jobId,
  confirm: true,
  actionToken: recoverActionToken.actionId
}, {
  workspaceRoot: targetRepoRoot,
  recoverWeaveflowCodexJob: async (input) => recoverWeaveflowCodexJob({
    ...input,
    runWorkerPreflight: okWorkerPreflight,
    startWorkerProcess: async () => ({ pid: process.pid })
  })
});
const cancelAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "cancel_job",
  jobId: "JOB-0903",
  confirm: true
}, {
  workspaceRoot: targetRepoRoot
});
const pauseAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "pause_chain",
  chainId: jobStart.chainId,
  confirm: true
}, {
  workspaceRoot: targetRepoRoot
});
const dangerousAction = await executeOperatorAction({
  workspaceRoot: targetRepoRoot,
  action: "push",
  jobId: jobStart.jobId,
  confirm: true
}, {
  workspaceRoot: targetRepoRoot
});
const structuredJobOutcome = [
  CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WEAVEFLOW_RUNTIME_UNAVAILABLE,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_CODEX_COMMAND_UNAVAILABLE,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_TARGET_WORKSPACE_MISSING,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_TARGET_WORKSPACE_NOT_GIT_REPO,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_GIT_PREFLIGHT_FAILED,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WORKER_SCRIPT_MISSING,
  CODEX_JOB_ACTION_OUTCOMES.BLOCKED_WORKER_UNAVAILABLE,
  CODEX_JOB_ACTION_OUTCOMES.JOB_CREATED_WORKER_START_FAILED,
  CODEX_JOB_ACTION_OUTCOMES.START_FAILED
].includes(jobStart.actionOutcome);
const bannedFallback = new RegExp([
  ["일반", "Codex", "장기", "세션"].join(" "),
  ["일반", "Codex로", "우회"].join(" ")
].join("|"));
console.log(formatPocSummary(summary));
console.log(JSON.stringify({
  ok: summary.ok && doctor.importOk === true && structuredJobOutcome && !bannedFallback.test(jobStartText),
  runtime: {
    doctorStatus: doctor.status,
    pluginAncestorResolvedRoot: pluginRuntimeResolution.runtimeRoot,
    runtimeRoot: runtime.runtimeRoot,
    pythonExecutable: runtime.pythonExecutable,
    weaveflowModulePath: runtime.weaveflowModulePath,
    pythonPathStartsWithRuntimeSrc: runtime.env.PYTHONPATH.startsWith(join(runtime.runtimeRoot, "src")),
    bridgeArgs: bridgeCommand.args,
    targetWorkspaceRoot: bridgeCommand.targetWorkspaceRoot
  },
  workerPreflight: {
    targetRepoRoot,
    targetAndRuntimeSeparated: targetRepoRoot !== runtime.runtimeRoot,
    structuredOutcome: structuredJobOutcome
  },
  chain: {
    chainId: jobStart.chainId,
    firstSegmentJobId: jobStart.jobId,
    firstSegmentIndex: jobStart.segmentIndex,
    checkShowsChain: jobCheck.chainId === jobStart.chainId,
    resumeCapsuleExists,
    recoveryPreparedPrompt: recoveryPreview.nextSuggestedPromptReady === true,
    nextSegmentStarted: nextSegment.nextSegment?.actionOutcome === CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB,
    nextSegmentJobId: nextSegment.nextJobId,
    usageLimitPauses: usageLimitDecision.shouldContinue === false &&
      usageLimitDecision.recommendedNextAction === "checkpoint_and_pause"
  },
  morningReview: {
    reportMarkdownPath: morningReview.artifactPaths.reviewMarkdownPath,
    reportJsonPath: morningReview.artifactPaths.reviewJsonPath,
    markdownExists: morningReviewMarkdownExists,
    jsonExists: morningReviewJsonExists,
    jobs: morningReview.summary.totalJobs,
    chains: morningReview.summary.totalChains,
    running: morningReview.summary.running,
    completedOrReady: morningReview.summary.readyForReview,
    blocked: morningReview.summary.blocked,
    stale: morningReview.summary.stale,
    chainAwareGrouping: morningReview.chains.length >= 1 &&
      morningReview.items.some((item) => item.kind === "job" && item.chainId === jobStart.chainId),
    responseSummary: /Morning review를 생성했습니다/.test(morningReviewText),
    noGeneralFallbackText: !bannedFallback.test(morningReviewText),
    topPriorityHasActionMenu: morningReview.topPriorities.some((item) => item.actionMenu?.actions?.length)
  },
  operatorAction: {
    menuHasTokens: actionMenu.actions.some((entry) => entry.actionToken),
    prepareRecoverCreatedPlan: prepareRecoverAction.status === "recovery_plan_prepared" &&
      Boolean(await readFile(prepareRecoverAction.recoveryPlanPath, "utf8").catch(() => "")),
    recoverPreviewOnly: recoverPreviewAction.status === "preview" && recoverPreviewAction.workerStarted === false,
    recoverWithTokenStartedOrStructured: [
      "recover_started_next_segment",
      "recover_blocked_or_failed",
      "blocked_missing_resume_or_recovery_plan",
      "blocked_recover_flow_unavailable"
    ].includes(recoverAction.status),
    recoverResultTextNoFallback: !bannedFallback.test(renderActionResultKo(recoverAction)),
    cancelRequestCreated: cancelAction.status === "cancel_requested" &&
      Boolean(await readFile(cancelAction.cancelRequestPath, "utf8").catch(() => "")),
    pauseDoesNotCancelWorker: pauseAction.status === "chain_paused" &&
      pauseAction.runningWorkerCancelled === false,
    dangerousDenied: dangerousAction.status === "dangerous_denied",
    noGeneralFallbackText: !bannedFallback.test([
      renderActionResultKo(prepareRecoverAction),
      renderActionResultKo(recoverPreviewAction),
      renderActionResultKo(dangerousAction)
    ].join("\n"))
  },
  jobStart: {
    actionOutcome: jobStart.actionOutcome,
    status: jobStart.status,
    jobId: jobStart.jobId,
    chainId: jobStart.chainId,
    workerStarted: jobStart.workerStarted,
    executionMode: jobStart.executionMode,
    policyDecision: jobStart.policyDecision,
    phasePlanPath: jobStart.phasePlanPath,
    workerPreflightPath: jobStart.workerPreflightPath,
    workerStartPath: jobStart.workerStartPath,
    checkTool: jobStart.checkTool,
    cancelTool: jobStart.cancelTool,
    recoverTool: jobStart.recoverTool,
    noGeneralFallbackText: !bannedFallback.test(jobStartText)
  },
  taskId: summary.taskId,
  pendingConfirmationSeen: summary.pendingConfirmationSeen,
  confirmationCompleted: summary.confirmationCompleted,
  taskListSeen: summary.taskListSeen,
  shutdownSucceeded: summary.shutdownSucceeded,
  errors: summary.errors
}, null, 2));

if (
  !summary.ok ||
  doctor.importOk !== true ||
  !structuredJobOutcome ||
  bannedFallback.test(jobStartText) ||
  !jobStart.chainId ||
  jobCheck.chainId !== jobStart.chainId ||
  !resumeCapsuleExists ||
  recoveryPreview.nextSuggestedPromptReady !== true ||
  nextSegment.nextSegment?.actionOutcome !== CODEX_JOB_ACTION_OUTCOMES.STARTED_JOB ||
  usageLimitDecision.shouldContinue !== false ||
  usageLimitDecision.recommendedNextAction !== "checkpoint_and_pause" ||
  !morningReviewMarkdownExists ||
  !morningReviewJsonExists ||
  morningReview.summary.totalJobs < 4 ||
  morningReview.summary.totalChains < 1 ||
  morningReview.summary.running < 1 ||
  morningReview.summary.readyForReview < 1 ||
  morningReview.summary.blocked < 1 ||
  morningReview.summary.stale < 1 ||
  !/Morning review를 생성했습니다/.test(morningReviewText) ||
  bannedFallback.test(morningReviewText) ||
  !morningReview.topPriorities.some((item) => item.actionMenu?.actions?.length) ||
  !actionMenu.actions.some((entry) => entry.actionToken) ||
  prepareRecoverAction.status !== "recovery_plan_prepared" ||
  recoverPreviewAction.status !== "preview" ||
  recoverPreviewAction.workerStarted !== false ||
  !["recover_started_next_segment", "recover_blocked_or_failed", "blocked_missing_resume_or_recovery_plan", "blocked_recover_flow_unavailable"].includes(recoverAction.status) ||
  bannedFallback.test(renderActionResultKo(recoverAction)) ||
  cancelAction.status !== "cancel_requested" ||
  pauseAction.status !== "chain_paused" ||
  pauseAction.runningWorkerCancelled !== false ||
  dangerousAction.status !== "dangerous_denied" ||
  (!providedRoot && targetRepoRoot === runtime.runtimeRoot)
) {
  process.exitCode = 1;
}

async function writeSmokeJob(workspaceRoot, jobId, state, options = {}) {
  const jobDir = join(workspaceRoot, ".weaveflow", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });
  await writeJsonAtomic(join(jobDir, "job.yaml"), state);
  await writeFile(join(jobDir, "events.jsonl"), `${JSON.stringify({ timestamp: state.updated_at, event: "job_created" })}\n`, "utf8");
  await writeJsonAtomic(join(jobDir, "start_outcome.json"), {
    status: state.status,
    action_outcome: state.action_outcome || state.status,
    jobId,
    workerStarted: state.status === "running"
  });
  if (options.result) {
    await writeFile(join(jobDir, "result.md"), options.result, "utf8");
  }
}
